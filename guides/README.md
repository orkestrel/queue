# Guides

A dual-axis index into this repository's guides — by concept, and by directory
(`AGENTS.md` § Documentation contract).

## By concept

| Concept | Spec                   | Source                    | Tests                                 |
| ------- | ---------------------- | ------------------------- | ------------------------------------- |
| Queue   | [`queue.md`](queue.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory  | Guide                  |
| ---------- | ---------------------- |
| `src/core` | [`queue.md`](queue.md) |

## Vendored guides

Every other guide in this folder is a byte-identical mirror shipped by a
dependency or by the `@orkestrel/scaffold` shared file set. Each documents
**that package's** surface, not anything sourced in this repository, so none is
a spec in the preceding concept index.

## Dependency reference

Each runtime dependency ships its guide as a local mirror beside its own
repository:

- [`abort.md`](abort.md) —
  [`@orkestrel/abort`](https://github.com/orkestrel/abort#readme), the
  cancellation primitive each attempt's `signal` is built on.
- [`contract.md`](contract.md) —
  [`@orkestrel/contract`](https://github.com/orkestrel/contract#readme), the
  guards, combinators, parsers, and shape DSL the factories are typed by.
- [`database.md`](database.md) —
  [`@orkestrel/database`](https://github.com/orkestrel/database#readme), the
  storage layer `DatabaseQueueStore` persists over.
- [`emitter.md`](emitter.md) —
  [`@orkestrel/emitter`](https://github.com/orkestrel/emitter#readme), the typed
  push-observation surface `Queue` exposes as `emitter`.
- [`timeout.md`](timeout.md) —
  [`@orkestrel/timeout`](https://github.com/orkestrel/timeout#readme), the
  deadline primitive backing each attempt's per-attempt timeout.

The development dependencies mirror their guides the same way:

- [`guide.md`](guide.md) — `@orkestrel/guide`, which powers this repository's
  guides-parity suite ([`tests/guides.test.ts`](../tests/guides.test.ts)).
- [`probe.md`](probe.md) — `@orkestrel/probe`, which drives the TypeScript
  claim prover.
- [`scaffold.md`](scaffold.md) — `@orkestrel/scaffold`, which vendors this
  repository's shared configuration, rules, and agent files.
- [`test.md`](test.md) — `@orkestrel/test`, which owns the recorders, waits, and
  scratch directories the suites import.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding contract; see `AGENTS.md`
  § Documentation contract for documentation-as-contracts.
