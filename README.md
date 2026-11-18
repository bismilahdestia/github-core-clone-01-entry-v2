[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/bismilahdestia/github-core-clone-01-entry-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/bismilahdestia/github-core-clone-01-entry-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01

A standalone, GitHub-compatible git forge in a single process, built for [the make.fun contest](https://make.fun/bounty/github-core-clone-01). No UI, no outside service, no git binary: it serves git smart HTTP (upload-pack protocol v2 and v0, receive-pack v0), the REST v3 API, GraphQL v4 and MCP from its own in-memory store, using only the Node.js standard library.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, and exits when the suite says done. `MAKEFUN_SHOP_TOKEN` is the bearer token every API call must carry.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll `/done`).
- `app.ts` — the HTTP server: routing, auth, and git smart HTTP.
- `git.ts` — git primitives: object ids, packfiles (parse + build, deltas), pkt-lines.
- `store.ts` — the forge store: repos, refs, objects, issues, pull requests, trees and commits.
- `rest.ts` — the REST v3 API (repos, contents, issues, labels, pulls, branches, commits).
- `graphql.ts` — a small GraphQL parser plus the resolvers for the suite's documents.
- `mcp.ts` — the MCP endpoint (modern `server/discover` and legacy `initialize` eras, six tools).

## How it works

Objects live in memory as raw git objects (SHA-1 over `<type> <size>\0` + bytes). Pushes arrive as packfiles (deltas resolved, including thin-pack bases the forge already holds); fetches walk the commit graph from the wants minus the haves, honouring shallow boundaries, and answer with plain-object packs. Contents and squash merges build trees and commits byte-exactly. Issues, pull requests, labels and comments share one store across REST, GraphQL and MCP, so a mutation on any surface reads back on the others.

## Performance design

The hot paths are deliberately cheap. Pack parsing inflates each zlib stream exactly once and reads the consumed byte count from the inflate engine instead of binary-searching for the stream end; packs are built with deflate level 1. Parsed commits, trees and tags are memoized per repository — git objects are immutable by oid, so a parsed view never goes stale. A ticket's GET-one response is cached as exact bytes and dropped by every mutation site. The request URL is parsed once, bodyless GET/HEAD requests never wait for the socket's `end` event, and a clone with no `have` lines skips the common-base walk entirely.
