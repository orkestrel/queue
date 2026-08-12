# Guides

A dual-axis index into this repository's guides — by concept, and by directory (AGENTS §22).

## By concept

| Concept | Spec                   | Source                    | Tests                                 |
| ------- | ---------------------- | ------------------------- | ------------------------------------- |
| Queue   | [`queue.md`](queue.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory  | Guide                  |
| ---------- | ---------------------- |
| `src/core` | [`queue.md`](queue.md) |

## Vendored guides

Two guides in this folder are byte-identical mirrors shipped by the
`@orkestrel/scaffold` shared file set. Each documents **that package's**
surface, not anything sourced in this repo, so neither is a spec in the concept
index above.

[`guide.md`](guide.md) mirrors the guide for `@orkestrel/guide` — the
devDependency powering this repo's guides-parity suite
([`tests/guides.test.ts`](../tests/guides.test.ts)). It documents `Guide` /
`Source`, the manifest, and the comparison helpers, so a reader of the parity
suite can see the primitives it is built from without leaving this guide set.

[`scaffold.md`](scaffold.md) mirrors the guide for `@orkestrel/scaffold` — the
devDependency that vendors this repo's shared configuration, rules, and agent
files. It documents the `new` / `audit` / `repair` / `catalog` / `overwrite`
commands and the vendored root they write.

## Dependency reference

This package's runtime dependencies are documented in their own repositories:

- [`@orkestrel/abort`](https://github.com/orkestrel/abort#readme) — the
  cancellation primitive each attempt's `signal` is built on.
- [`@orkestrel/contract`](https://github.com/orkestrel/contract#readme) — the
  guards, combinators, parsers, and shape DSL the factories are typed by.
- [`@orkestrel/database`](https://github.com/orkestrel/database#readme) — the
  storage layer `DatabaseQueueStore` persists over.
- [`@orkestrel/emitter`](https://github.com/orkestrel/emitter#readme) — the
  typed push-observation surface `Queue` exposes as `emitter`.
- [`@orkestrel/timeout`](https://github.com/orkestrel/timeout#readme) — the
  deadline primitive backing each attempt's per-attempt timeout.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
