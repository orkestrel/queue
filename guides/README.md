# Guides

A dual-axis index into this repository's guides — by concept, and by directory (AGENTS §22).

## By concept

| Concept | Spec                           | Source                    | Tests                                 |
| ------- | ------------------------------ | ------------------------- | ------------------------------------- |
| Queue   | [`src/queue.md`](src/queue.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory  | Guide                          |
| ---------- | ------------------------------ |
| `src/core` | [`src/queue.md`](src/queue.md) |

## Dependency reference

[`src/abort.md`](src/abort.md) is a byte-identical mirror of the guide for
`@orkestrel/abort` — a runtime dependency, the cancellation primitive each
attempt's `signal` is built on. It documents **that package's** surface
(a typed `AbortController` wrapper), not anything sourced in this repo; it is
kept here so a reader of this package can see the primitive it is built from
without leaving this guide set.

[`src/contract.md`](src/contract.md) is a byte-identical mirror of the guide
for `@orkestrel/contract` — a runtime dependency. It documents **that
package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of this package can
see the primitives it is built from without leaving this guide set.

[`src/database.md`](src/database.md) is a byte-identical mirror of the guide
for `@orkestrel/database` — a runtime dependency, the storage layer
`DatabaseQueueStore` persists over. It documents **that package's** surface
(the database, tables, and driver layer), not anything sourced in this repo;
it is kept here so a reader of this guide can see the persistence layer
without leaving this guide set.

[`src/emitter.md`](src/emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — a runtime dependency, the typed push-observation
surface `Queue` exposes as `emitter`. It documents **that package's** surface,
not anything sourced in this repo; it is kept here for the same reason.

[`src/timeout.md`](src/timeout.md) is a byte-identical mirror of the guide for
`@orkestrel/timeout` — a runtime dependency, the deadline primitive backing
each attempt's per-attempt timeout. It documents **that package's** surface
(a typed countdown timer), not anything sourced in this repo; it is kept here
so a reader of this package can see the primitive it is built from without
leaving this guide set.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides/src/parity.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not
anything sourced in this repo; it is kept here so a reader of the parity suite
can see the primitives it is built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
