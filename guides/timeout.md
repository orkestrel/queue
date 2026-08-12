# Timeout

> A controllable `setTimeout` wrapper that exposes an `AbortSignal` which fires
> on expiry, for racing work against a deadline. A `Timeout` carries a trace
> `id`, a deadline `ms`, and `start()` / `clear()` controls — arm the deadline,
> then race its `signal` against work to bound how long that work may run. The
> time-bound half of the substrate's time-and-cancellation pair. Deliberately
> thin: it is not a scheduler, not a debounce/throttle, not a retry policy —
> just one `setTimeout` made re-armable, clearable, and parent-linkable. Its
> native `AbortSignal` is the complete observation surface; there is no separate
> event map. `start()` arms the deadline, `clear()` cancels it without firing,
> and re-`start()`ing after an expiry swaps in a fresh signal, so a handle is
> reusable across deadlines without re-construction. Source:
> [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a deadline handle, arm it, and hand its `signal` to deadline-aware
work — `clear()` the deadline if the work finishes first:

```ts
import { createTimeout } from '@orkestrel/timeout'

const timeout = createTimeout({ ms: 5_000 })
timeout.start()

// `signal` aborts on expiry — pass it anywhere a native AbortSignal is accepted:
const response = await fetch(url, { signal: timeout.signal })

timeout.clear() // work finished first — cancel the deadline
```

Construction is a strict JavaScript boundary. Options must be a plain readable
record; a defined `id` must be a string; `ms` must be an integer in the
inclusive range from `0` through `MAX_TIMEOUT_MS`; and a defined parent
`signal` must be a genuine native `AbortSignal`. Invalid input throws
`ContractError` from `@orkestrel/contract`: malformed or unreadable options use
code `bound`, while invalid `id`, `ms`, and `signal` values use `literal`,
`range`, and `placement`, respectively. Each error carries safe `path`, `limit`,
and `received` context. The package does not re-export `ContractError`.

An optional parent signal CLEARS the timeout rather than expiring it if it
aborts before the deadline. An optional `id` labels the handle for tracing and
defaults to a random UUID.

### Factories

| API             | Kind     | Summary                                                            |
| --------------- | -------- | ------------------------------------------------------------------ |
| `createTimeout` | function | Create a `TimeoutInterface` deadline handle from `TimeoutOptions`. |

### Entities

| API       | Kind  | Summary                                                                       |
| --------- | ----- | ----------------------------------------------------------------------------- |
| `Timeout` | class | The controllable `setTimeout` wrapper; implements `TimeoutInterface` exactly. |

### Constants

| API              | Kind  | Summary                                                  |
| ---------------- | ----- | -------------------------------------------------------- |
| `MAX_TIMEOUT_MS` | const | Largest accepted duration: `2_147_483_647` milliseconds. |

### Validators

| API                 | Kind     | Summary                                                        |
| ------------------- | -------- | -------------------------------------------------------------- |
| `isTimeoutDuration` | function | Total validator for an integer in the inclusive timeout range. |
| `isTimeoutSignal`   | function | Total native-brand validator for a genuine `AbortSignal`.      |

### Helpers

| API                      | Kind     | Summary                                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------------------------- |
| `validateTimeoutOptions` | function | Validate once-read timeout options and return a fresh copy omitting absent option keys. |

### Types

| Type               | Kind      | Shape                                                                                                |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------------- |
| `TimeoutOptions`   | interface | `{ id?: string; ms: number; signal?: AbortSignal }` — options for `createTimeout` / the constructor. |
| `TimeoutInterface` | interface | `id` / `ms` / `signal` / `expired` data members + `start` / `clear` methods.                         |

The `id`, `ms`, `signal`, and `expired` members are `readonly` data members of
`TimeoutInterface` (Surface rows, above) — its call-signature methods are
documented under [Methods](#methods). `expired` derives directly from the owned
signal's `aborted` state rather than storing a duplicate lifecycle flag.

## Methods

The public methods of `TimeoutInterface` — every call-signature member listed
(its `readonly` data members `id` / `ms` / `signal` / `expired` stay Surface
rows). `Timeout` implements the interface exactly, so this doubles as the
class's instance-method surface (AGENTS §22).

#### `TimeoutInterface`

`start` arms (or re-arms) the deadline; `clear` cancels a pending expiry
without firing.

| Method  | Returns | Behavior                                                                                           |
| ------- | ------- | -------------------------------------------------------------------------------------------------- |
| `start` | `void`  | Arm the deadline for `ms`. Re-arming swaps a fresh `signal` if the prior one fired.                |
| `clear` | `void`  | Cancel a pending expiry without firing `signal`; after expiry, swap in a fresh non-aborted signal. |

## Contract

These invariants hold across `src/core` ↔ `timeout.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` /
   `interface` row in the `## Surface` tables is a real export of the timeout
   source, and every export appears as a Surface row — exhaustive, both
   directions (AGENTS §22).
2. **Strict construction boundary.** `validateTimeoutOptions` requires a plain
   readable record, reads `id`, `ms`, and `signal` exactly once inside a
   contained boundary, validates them, and returns a fresh normalized copy that
   omits absent optional keys. Defined identifiers must be strings, durations
   must be integers in inclusive `[0, MAX_TIMEOUT_MS]`, and defined parent
   signals must pass the native brand check. `Timeout` calls this helper before
   allocating its controller or listener. Negative zero and zero are valid;
   zero intentionally expires on the next turn. Invalid inputs throw the coded
   `ContractError` taxonomy described under Surface.
3. **Deadline signal and derived expiry.** The exposed `signal` fires (aborts)
   on expiry. `expired` derives from that owned signal's `aborted` state, so the
   two facts cannot drift.
4. **Signal identity swaps only on a real expiry.** A cleared-but-never-fired
   timeout keeps its original `signal` (not aborted); the identity is only
   swapped for a fresh, non-aborted controller after the current controller has
   fired — whether that swap happens inside `clear()` or at the next `start()`.
5. **Parent linking clears, never expires.** A parent `options.signal` abort
   CLEARS the timeout — it does not expire the timeout, abort the timeout's own
   signal, or forward the parent reason. The parent listener is attached only
   while a timer is armed (added on `start()`, removed on expiry or `clear()`);
   once the parent has aborted, a later `start()` is a no-op.
6. **Identifiers are strict.** Omitted `id` values generate a random UUID and an
   empty string is retained, but every other defined non-string value throws a
   `literal`-coded `ContractError` rather than being coerced or replaced.
7. **Native observation.** Consumers observe expiry through the complete native
   `AbortSignal`; `Timeout` adds no `Emitter` or parallel event system.

## Patterns

### Race work against a deadline

```ts
import { createTimeout } from '@orkestrel/timeout'

async function fetchWithDeadline(url: string, ms: number): Promise<Response> {
	const timeout = createTimeout({ ms })
	timeout.start()

	try {
		return await fetch(url, { signal: timeout.signal })
	} finally {
		timeout.clear() // no-op if the fetch already won the race
	}
}
```

### Link a parent signal

A parent `AbortSignal` clears the deadline instead of letting it expire — so
an outer cancellation (a request abort, a shutdown signal) short-circuits the
timer cleanly without aborting the timeout's own signal:

```ts
import { createTimeout } from '@orkestrel/timeout'

function withDeadline(parent: AbortSignal, ms: number) {
	const timeout = createTimeout({ id: 'request-deadline', ms, signal: parent })
	timeout.start()

	timeout.signal.addEventListener(
		'abort',
		() => {
			if (timeout.expired) giveUp() // only a real timeout expiry reaches this listener
		},
		{ once: true },
	)

	return timeout
}
```

### Reuse a handle across deadlines

```ts
import { createTimeout } from '@orkestrel/timeout'

const timeout = createTimeout({ ms: 100 })

timeout.start()
timeout.clear() // cancels before firing — expired stays false

timeout.start() // re-armed; a fresh deadline window begins
```

### Practices

- **Race, don't poll** — attach a listener to `signal` (or pass it straight to
  an API that accepts an `AbortSignal`, e.g. `fetch`) rather than polling
  `expired`.
- **`clear()` is always safe to call** — clearing an idle or already-cleared
  handle is a no-op; after expiry it installs a fresh non-aborted signal. Call
  it unconditionally in a `finally`.
- **Keep parent cancellation distinct** — a parent abort clears the timer but
  does not abort the timeout signal or forward the parent reason.
- **Reuse, don't reconstruct** — call `start()` again on the same handle for a
  new deadline window instead of constructing a fresh `Timeout`.

## Tests

- [`tests/src/core/Timeout.test.ts`](../tests/src/core/Timeout.test.ts) —
  public-constructor integration, real expiry / clear / replacement / churn
  behavior, signal identity and derived expiry, and the intentional parent-clear
  lifecycle.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — fresh
  normalized copies, omitted optional keys, exactly-once property reads, hostile
  getter containment, duration boundaries, and exact structured errors.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) —
  total duration and native-signal validation, including spoofed values and a
  revoked proxy.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) —
  `createTimeout` returns a working `TimeoutInterface` and preserves the strict
  construction boundary.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §10 lifecycle (`start` / `clear`),
  §8 options design, §22 documentation-as-contracts.
- [`contract.md`](contract.md) — the mirrored guide for `@orkestrel/contract`,
  the source of the validation primitives and `ContractError` used at the
  construction boundary.
- [`guide.md`](guide.md) — the mirrored guide for `@orkestrel/guide`, the
  devDependency powering this repo's guides-parity test suite.
- [`README.md`](README.md) — the guides index.
