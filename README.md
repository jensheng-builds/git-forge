# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jensheng-builds/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jensheng-builds/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process, written from scratch on the standard library alone — no dependencies, no database, no `git` binary. It is built for the [make.fun "Build a GitHub-compatible git forge" bounty](https://make.fun/c/github-core-clone-01).

## Run it

```sh
MAKEFUN_SHOP_TOKEN=shpat_... node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it does

- **Git smart HTTP** — clone, fetch and push with a real git client:
  protocol v2 (`ls-refs`, `fetch` with shallow/deepen) and v0, packfiles
  written and read by hand (including OFS/REF delta resolution), annotated
  tags, branch/tag deletion, fast-forward enforcement with report-status.
- **REST API v3** — repositories (create/list with `Link` pagination,
  patch, delete), the contents API (create/update with stale-sha 409,
  delete, directory listings), branches, commits, git refs, labels,
  issues with comments, and pull requests with file diffs and
  merge/squash-merge (conflicts answer 405).
- **GraphQL v4 subset** — `viewer`, `repository`, `node(id:)` with opaque
  stable global ids, issue/pull-request connections with cursor
  pagination, `__type` introspection, batched requests, and the
  createIssue / closeIssue / createPullRequest / mergePullRequest /
  addComment mutations — all reading and writing the same store as REST.
- **MCP endpoint** — JSON-RPC at `/mcp` with `server/discover` (plus the
  legacy `initialize` handshake) and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) that share state with every other surface.

Everything lives in memory; authentication is a single bearer token.

The entrypoint is `main.ts`, which implements the contest lifecycle: it
starts the server on an ephemeral port, registers the port with the
harness, and waits to be told it is done.

`app.ts` exports `startServer()` (used by `main.ts`) and the whole forge
can be embedded in-process. Layout:

- `main.ts` — contest lifecycle (register, wait, exit)
- `app.ts` — HTTP routing, REST v3, GraphQL endpoint, MCP endpoint
- `store.ts` — in-memory store, git object model, three-way merge, diffs
- `gitproto.ts` — pkt-lines, packfiles, upload-pack / receive-pack
- `graphql.ts` — the GraphQL parser/executor for the forge's schema slice

## License

MIT — see `LICENSE`.
