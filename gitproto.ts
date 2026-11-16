// gitproto.ts — git smart HTTP, implemented from the protocol up.
//
// pkt-lines, packfiles (read and write, with OFS/REF delta resolution),
// the v0 and v2 upload-pack exchanges (advertisement, ls-refs, fetch with
// shallow/deepen support) and the v0 receive-pack exchange with
// report-status. Only node:zlib and node:crypto help; there is no git
// binary anywhere near this file.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID, hashObject, parseCommit, parseTag } from './store.ts';
import type { Forge, GitObject, ObjectType, Repo } from './store.ts';

// ------------------------------------------------------------------ pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from(FLUSH);
}

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** A sequential pkt-line reader over a request body. */
export class PacketReader {
  private offset = 0;
  private readonly body: Buffer;

  constructor(body: Buffer) {
    this.body = body;
  }

  /** The next packet, or null when the body is exhausted. Throws on garbage. */
  next(): Packet | null {
    if (this.offset >= this.body.length) return null;
    if (this.offset + 4 > this.body.length) throw new Error('truncated pkt-line header');
    const header = this.body.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'end', payload: Buffer.alloc(0) };
    }
    if (length < 4 || this.offset + length > this.body.length) throw new Error('pkt-line overruns the body');
    const payload = this.body.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Everything not yet consumed (a receive-pack body ends in a raw packfile). */
  rest(): Buffer {
    return this.body.subarray(this.offset);
  }
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a complete (delta-free) packfile from whole objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and resolve every object in it. `external` supplies base
 * objects the pack leaves out (a thin pack against the repository's store).
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    type: ObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = start - value;
    } else if (code === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    if (code === 6) raw.push({ offset: start, type: 'ofs-delta', data: inflated.data, baseOffset });
    else if (code === 7) raw.push({ offset: start, type: 'ref-delta', data: inflated.data, baseOid });
    else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`pack entry type ${code}`);
      raw.push({ offset: start, type, data: inflated.data });
    }
  }

  const byOffset = new Map<number, GitObject>();
  const resolved = new Map<string, GitObject>();
  const resolveEntry = (entry: RawEntry): GitObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      const object: GitObject = { type: entry.type, data: entry.data };
      byOffset.set(entry.offset, object);
      resolved.set(hashObject(object.type, object.data), object);
      return object;
    }
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta') {
      base = byOffset.get(entry.baseOffset as number);
      if (base === undefined) {
        const baseEntry = raw.find((candidate) => candidate.offset === entry.baseOffset);
        if (baseEntry !== undefined) base = resolveEntry(baseEntry);
      }
    } else {
      base = resolved.get(entry.baseOid as string) ?? external?.(entry.baseOid as string);
    }
    if (base === undefined) throw new Error('delta base is missing');
    const object: GitObject = { type: base.type, data: applyDelta(base.data, entry.data) };
    byOffset.set(entry.offset, object);
    resolved.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (const entry of raw) resolveEntry(entry);
  return resolved;
}

// ------------------------------------------------------------------ object selection for a fetch

/** Every object reachable from `roots`; commit parents are not followed past `stopCommits`. */
export function collectObjects(repo: Repo, roots: readonly string[], stopCommits: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.getObject(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      if (!stopCommits.has(oid)) for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      // Walk the binary tree entries structurally.
      let cursor = 0;
      const data = object.data;
      while (cursor < data.length) {
        const space = data.indexOf(0x20, cursor);
        const nul = data.indexOf(0x00, space + 1);
        if (space < 0 || nul < 0) break;
        stack.push(data.subarray(nul + 1, nul + 21).toString('hex'));
        cursor = nul + 21;
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

export interface FetchPlan {
  /** Object ids to pack and send. */
  send: string[];
  /** Commits that form the new shallow boundary. */
  shallow: string[];
  /** Client boundary commits that stop being shallow. */
  unshallow: string[];
}

/**
 * Work out what a fetch delivers: the closure of the wants (bounded by
 * `depth` commit generations when one is given), minus everything the
 * haves already cover (a client's shallow boundary stops that coverage at
 * the boundary commit itself, which the client holds with its tree).
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const boundary = new Set(clientShallow);
  const haveSet = collectObjects(repo, haves, boundary);

  let include: Set<string>;
  const newBoundary: string[] = [];
  if (depth === null) {
    include = collectObjects(repo, wants);
  } else {
    include = new Set<string>();
    // Generations are counted over commits; tags peel for free, and the
    // trees and blobs of an included commit always travel with it.
    const generation = new Map<string, number>();
    const queue: string[] = [];
    const seedCommit = (oid: string): void => {
      const commit = repo.peelToCommit(oid);
      if (commit !== undefined && !generation.has(commit)) {
        generation.set(commit, 1);
        queue.push(commit);
      }
      // Tag objects on the path to a wanted commit are part of the fetch.
      let cursor: string | undefined = oid;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        const object = repo.getObject(cursor);
        if (object === undefined || object.type !== 'tag') break;
        include.add(cursor);
        cursor = parseTag(object.data).object;
      }
    };
    for (const want of wants) seedCommit(want);
    while (queue.length > 0) {
      const commit = queue.shift() as string;
      const gen = generation.get(commit) as number;
      if (gen > depth) continue;
      include.add(commit);
      const view = parseCommit((repo.getObject(commit) as GitObject).data);
      for (const oid of collectObjects(repo, [view.tree])) include.add(oid);
      if (gen === depth) {
        if (view.parents.length > 0) newBoundary.push(commit);
      } else {
        for (const parent of view.parents) {
          if (!generation.has(parent)) {
            generation.set(parent, gen + 1);
            queue.push(parent);
          }
        }
      }
    }
  }

  const send = [...include].filter((oid) => !haveSet.has(oid));
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const object = repo.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => include.has(parent) || haveSet.has(parent))) {
      if (parents.some((parent) => include.has(parent) && !haveSet.has(parent))) unshallow.push(oid);
    }
  }
  // A depth-less fetch sends no new boundary; a deepen moves it (newBoundary).
  return { send, shallow: depth === null ? [] : newBoundary, unshallow };
}

// ------------------------------------------------------------------ advertisements

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.getObject(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return repo.peelToCommit(oid);
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow agent=git-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta quiet agent=git-forge/1.0';

export function advertise(forge: Forge, owner: string, name: string, service: string, protocolV2: boolean): HttpResult {
  const repo = forge.repoFor(owner, name);
  if (repo === undefined) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('repository not found\n') };
  if (service === 'git-upload-pack' && protocolV2) {
    const lines = ['version 2\n', 'agent=git-forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'object-format=sha1\n'];
    const body = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${repo.headRef}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headOid = repo.refs.get(repo.headRef);
    const headLine = `${headOid ?? ZERO_OID} HEAD`;
    const lines: string[] = [headLine];
    for (const [ref, oid] of refs) {
      lines.push(`${oid} ${ref}`);
      const peeled = peeledOf(repo, oid);
      if (peeled !== undefined) lines.push(`${peeled} ${ref}^{}`);
    }
    for (const line of lines) {
      parts.push(pktLine(first ? `${line}\0${caps}\n` : `${line}\n`));
      first = false;
    }
  }
  parts.push(pktFlush());
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------ upload-pack

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  if (pack.length === 0) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

function fetchResponse(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null, version2: boolean): Buffer {
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const objects = plan.send
    .map((oid) => repo.getObject(oid))
    .filter((object): object is GitObject => object !== undefined);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (version2) {
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const known = haves.filter((have) => repo.getObject(have) !== undefined);
      if (known.length === 0) parts.push(pktLine('NAK\n'));
      else for (const have of known) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
      parts.push(pktFlush());
    }
    const shallowLines: string[] = [];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    if (shallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const line of shallowLines) parts.push(pktLine(line));
      parts.push(pktFlush());
    }
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(pktFlush());
  } else {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    const known = haves.filter((have) => repo.getObject(have) !== undefined);
    if (known.length === 0) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine(`ACK ${known[known.length - 1]}\n`));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headOid = repo.refs.get(repo.headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:${repo.headRef}\n` : `${headOid} HEAD\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${repo.headRef}\n`);
    } else {
      lines.push(`${ZERO_OID} HEAD symref-target:${repo.headRef}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

export function uploadPack(forge: Forge, owner: string, name: string, body: Buffer, protocolV2: boolean): HttpResult {
  const repo = forge.repoFor(owner, name);
  if (repo === undefined) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('repository not found\n') };
  const reader = new PacketReader(body);
  const first = reader.next();
  if (first === null || first.kind !== 'data') throw new Error('empty upload-pack request');
  const firstLine = first.payload.toString('utf8');

  if (protocolV2 || firstLine.startsWith('command=')) {
    const command = firstLine.trim().slice('command='.length);
    // Capability lines run until the delimiter; command arguments follow it.
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'delim' || packet.kind === 'flush') break;
    }
    const args: string[] = [];
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, wants, haves, shallow, depth, true) };
    }
    throw new Error(`unknown v2 command ${command}`);
  }

  // Protocol v0: wants and shallow/deepen up to a flush, then haves and done.
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  const readLine = (packet: Packet): string => packet.payload.toString('utf8').replace(/\n$/, '');
  let line = firstLine.replace(/\n$/, '');
  for (;;) {
    const [head] = line.split(' ');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
    void head;
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') break;
    if (packet.kind === 'data') line = readLine(packet);
  }
  const haves: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') break;
    if (packet.kind === 'data') {
      const text = readLine(packet);
      if (text.startsWith('have ')) haves.push(text.slice(5, 45));
    }
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, wants, haves, shallow, depth, false) };
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, owner: string, name: string, body: Buffer): HttpResult {
  const repo = forge.repoFor(owner, name);
  if (repo === undefined) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('repository not found\n') };
  const reader = new PacketReader(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = reader.rest();
  const sideband = capabilities.split(' ').includes('side-band-64k');
  const reportStatus = capabilities.split(' ').includes('report-status') || capabilities.split(' ').includes('report-status-v2');

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const incoming = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const [oid, object] of incoming) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      fail(command.oldOid === ZERO_OID ? 'reference already exists' : 'stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.getObject(command.newOid);
    if (target === undefined) {
      fail('unknown object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && command.oldOid !== ZERO_OID) {
      const oldCommit = repo.peelToCommit(command.oldOid);
      const newCommit = repo.peelToCommit(command.newOid);
      if (oldCommit === undefined || newCommit === undefined || !repo.isAncestor(oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!reportStatus) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportPackets = reportLines.map((line) => pktLine(line));
  let responseBody: Buffer;
  if (sideband) {
    // The demultiplexed band-1 stream is itself a pkt-line stream and must
    // end with its own flush packet before the outer flush closes the reply.
    const stream = Buffer.concat([...reportPackets, pktFlush()]);
    const wrapped: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < stream.length; offset += CHUNK) {
      const chunk = stream.subarray(offset, Math.min(stream.length, offset + CHUNK));
      wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    responseBody = Buffer.concat([...wrapped, pktFlush()]);
  } else {
    responseBody = Buffer.concat([...reportPackets, pktFlush()]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}
