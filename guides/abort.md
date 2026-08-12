# Abort

> The cancellation primitive: a thin, traceable wrapper over a native `AbortController`. An `Abort` carries a trace `id`, exposes a standard `AbortSignal` you hand to any cancellable API, and can be **linked to a parent signal** so it fires when either its own `abort()` is called or the parent aborts — cancellation cascades through a tree of handles with no listener bookkeeping. Async layers bound their work against a `signal`.
>
> Deliberately thin. It does **not** re-implement cancellation machinery — the native `AbortController` is the engine; `Abort` only adds a traceable `id` and parent-linking on top. It does **not** wrap the signal in a bespoke interface, so it stays interoperable with `fetch`, streams, and every Web API that already speaks `AbortSignal`. The native signal is the complete observation contract: consumers inspect `aborted` and `reason` or subscribe to its standard `abort` event. Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a cancellation handle, hand its `signal` to cancellable work, and `abort()` to cancel:

```ts
import { createAbort } from '@orkestrel/abort'

const abort = createAbort({ id: 'fetch-user' })
const response = await fetch(url, { signal: abort.signal })
abort.abort() // cancels the in-flight fetch via the native signal; `aborted` flips true
```

The `signal` is a plain `AbortSignal`, so it drops into anything that takes one. Call `abort()` to cancel and `abort(reason)` to attach a value the cancelled work can read off `signal.reason`. Aborting is idempotent — the first call wins, and a second is a safe no-op. Pass a parent `signal` to link cancellation: the child's `signal` then fires when the parent aborts, so one cancellation cascades to every linked handle (via `AbortSignal.any`, no listener bookkeeping). Pass `id` to label a handle for tracing, or let it default to a random UUID.

Construction is a strict JavaScript boundary. `validateAbortOptions` normalizes omitted options to a fresh empty object; otherwise it requires a plain record, reads `id` and `signal` exactly once inside a contained boundary, and returns a fresh copy omitting absent keys. A provided `id` must be a string and a provided parent `signal` must be native. Invalid values fail immediately with a coded `ContractError`: malformed or unreadable options use `bound`, a nonstring id uses `literal`, and a nonnative option signal uses `placement`, with exact `options`, `options.id`, or `options.signal` context, limits, safe previews, and the originating cause for unreadable records. Direct `linkSignal` calls independently validate `own` and `parent` as native signals with `placement` context. An `undefined` `id` still generates a UUID, while an empty string remains a valid explicit id.

### Factories

| API           | Kind     | Summary                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `createAbort` | function | Create an `AbortInterface`, optionally with a trace `id` and a parent `signal`. |

### Helpers

| API                    | Kind     | Summary                                                                                                                    |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `validateAbortOptions` | function | Validate once-read abort options and return a fresh copy omitting absent optional keys.                                    |
| `linkSignal`           | function | Link an own `AbortSignal` to an optional parent signal, returning `AbortSignal.any([own, parent])` when a parent is given. |

### Validators

| API             | Kind     | Summary                                                                                                   |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `isAbortSignal` | function | Total native-brand guard for `AbortSignal`; structural spoofs and hostile or revoked proxies fail safely. |

### Entities

| API     | Kind  | Summary                                                                    |
| ------- | ----- | -------------------------------------------------------------------------- |
| `Abort` | class | A traceable `AbortController` wrapper whose `signal` can link to a parent. |

### Types

| Type             | Kind      | Shape                                                                                  |
| ---------------- | --------- | -------------------------------------------------------------------------------------- |
| `AbortOptions`   | interface | `{ id?: string; signal?: AbortSignal }` — options for `createAbort` / the constructor. |
| `AbortInterface` | interface | `id` / `signal` / `aborted` data members + the `abort` method.                         |

The `id`, `signal`, and `aborted` members of `AbortInterface` are `readonly` data members (Surface rows, above) — its call-signature method is documented under [Methods](#methods).

## Methods

The public methods of `AbortInterface` — every call-signature member listed (its `readonly` data members `id` / `signal` / `aborted` stay Surface rows). `Abort` implements the interface exactly, so this doubles as the class's instance-method surface (AGENTS §22).

#### `AbortInterface`

`abort` is the §10 cancellation verb — it aborts the underlying controller, flipping `aborted` and firing `signal`.

| Method  | Returns | Behavior                                                                                                                                                                 |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `abort` | `void`  | Cancel — abort the controller, flip `aborted`, and fire `signal` (with `reason`; `undefined`/omitted becomes a default `AbortError`). Idempotent: re-calling is a no-op. |

## Contract

These invariants hold across `src/core` ↔ `abort.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the aborts module, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **Native wrapper.** `Abort` owns a private `AbortController`; `abort(reason?)` delegates to `controller.abort(reason)`, and `aborted` reads the exposed `signal.aborted`. No re-implemented cancellation machinery.
3. **Parent linking via `AbortSignal.any`.** With a parent `signal`, the exposed `signal` is `AbortSignal.any([own, parent])`, so it fires on EITHER the own `abort()` or the parent aborting — and the own `abort()` does NOT abort the parent. Without a parent, `signal` is the own controller's signal directly.
4. **Reason propagates.** `abort(reason)` forwards the reason to the controller, so `signal.reason` is the value passed in — when the own `abort()` is what fired the signal. Any DEFINED reason is preserved by identity, including falsy ones (`null`, `0`, `''`, `false`, `NaN`) — never `if (reason)`-gated. When the reason is `undefined` (or omitted), the host substitutes a default `AbortError` `DOMException`, so cancelled work always has a reason to inspect rather than `undefined`. On a linked handle whose PARENT aborted first, `signal.reason` is the parent's reason instead (correct `AbortSignal.any` semantics: the signal carries the reason of whichever source fired it).
5. **Idempotent — first reason sticks.** A handle aborts at most once: a second (or third) `abort(reason2)` neither re-fires `signal` nor overwrites `reason`, even when the first reason was a falsy `0` / `''`. A handle linked to a parent that has ALREADY aborted at construction is born aborted (`aborted === true`, carrying the parent's reason) — its own later `abort()` is then a safe no-op.
6. **Traceable identity.** `id` is a stable string for the handle's lifetime — caller-supplied via `options.id`, or a `crypto.randomUUID()` default that is unique across instances (verified across a large batch).
7. **Native observation contract.** The exposed `AbortSignal` is the complete observation surface: consumers read `aborted` / `reason` and subscribe to the standard `abort` event. The package adds no parallel event system.
8. **Strict JavaScript boundaries.** `validateAbortOptions` normalizes omission to a fresh object; otherwise it requires a plain readable record, reads each declared option exactly once, validates a defined string `id` and native parent `signal`, and returns a fresh normalized copy without absent keys before controller allocation or link composition. Invalid options use `bound`, invalid ids use `literal`, and invalid option signals use `placement`, with exact paths, limits, safe previews, and preserved causes for unreadable records. `linkSignal` separately guards its direct `own` and `parent` inputs with `placement` errors and native-signal limits. Structural spoofs and hostile or revoked proxies are rejected without leaking native errors.
9. **DOC ↔ SOURCE method bijection.** The `## Methods` table lists exactly `AbortInterface`'s public methods — exhaustive, both directions — and `Abort` exposes the same public methods, no more (AGENTS §22).

## Patterns

### Create and abort

```ts
import { createAbort } from '@orkestrel/abort'

const abort = createAbort()
const stream = openStream({ signal: abort.signal })
// later, to cancel:
abort.abort('user navigated away') // signal.reason carries the value
```

### Link to a parent (cascading cancellation)

A child handle linked to a parent `signal` fires when the parent aborts — one cancellation cascades to every linked handle, without manual listener wiring.

```ts
import { createAbort } from '@orkestrel/abort'

const parent = createAbort({ id: 'request' })
const child = createAbort({ id: 'sub-task', signal: parent.signal })

parent.abort() // child.aborted is now true; child.signal has fired
// the child can still be aborted on its own without touching the parent
```

### Race work against the signal

The cleanest bound is to thread `signal` straight into work that already accepts one — then a single `abort()` cancels the whole chain natively, no race to write:

```ts
import { createAbort } from '@orkestrel/abort'

const abort = createAbort()
const rows = await query(sql, { signal: abort.signal }) // cancels at the source on abort
```

When the work does NOT take a signal, race it against the abort. The native `signal.reason` is what `abort(reason)` stored (or the default `AbortError`), so reject with it directly:

```ts
import { createAbort } from '@orkestrel/abort'

async function run<T>(work: Promise<T>, abort = createAbort()): Promise<T> {
	const cancelled = new Promise<never>((_, reject) =>
		abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }),
	)
	return Promise.race([work, cancelled])
}
```

### Practices

- **Hand off the `signal`, keep the handle** — pass `abort.signal` into cancellable APIs (`fetch`, a stream, a worker); keep the `Abort` to call `abort()`. Prefer threading the signal into work that accepts one over racing it yourself.
- **Link, don't re-wire** — pass a parent `signal` to cascade cancellation; `AbortSignal.any` does the bookkeeping, so never hand-roll `addEventListener` chains between handles.
- **Carry a reason** — pass a value to `abort(reason)`; it surfaces on `signal.reason` for the cancelled work to inspect. Any defined value is kept as-is (even a falsy `0` / `''`); only `undefined` is replaced with a default `AbortError`.
- **Label for tracing** — set `id` on long-lived or correlated handles; let it default to a UUID otherwise.
- **Observe the native signal** — inspect `aborted` / `reason` or subscribe to the standard `abort` event; no parallel event abstraction is needed.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports) and the `AbortInterface` ↔ `Abort` method bijection.
- [`tests/src/core/Abort.test.ts`](../tests/src/core/Abort.test.ts) — `abort()` flips `aborted` and fires `signal`, `abort(reason)` propagates the reason, a second/third `abort(reason2)` is an idempotent no-op (`signal.reason` stays the first reason), a fresh handle is not aborted, parent linking (the signal fires on the parent's abort and on its own; a parent that aborts first propagates the parent's reason), and `id` is honored / stable / unique (across a 1,000-instance batch). Edge cases: every reason type (`undefined`/omitted → a default `AbortError` `DOMException`; string / object / the falsy-but-defined `null` / `0` / `''` / `false` / `NaN` preserved by identity; first falsy reason still sticks), a parent already aborted at construction (born aborted, carrying the parent's reason, own `abort()` then inert), chained Aborts (an `Abort` parented to another's `signal`, 2–3 levels: a root abort fans down with its reason, a mid/leaf abort never flows up), `new Abort` ↔ `createAbort` parity, and proportionate public-constructor boundary integration.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — `createAbort` returns a working `AbortInterface` and honors `id` / a parent `signal`.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — `validateAbortOptions` fresh normalization, optional-key omission, exactly-once reads, hostile getter containment, and exact taxonomy/context; plus `linkSignal` own/parent composition and exact direct-call placement errors.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — `isAbortSignal` accepts a native signal and remains total for structural spoofs and revoked proxies.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §10 lifecycle (`abort`), §4.1 single-word members, §22 documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
