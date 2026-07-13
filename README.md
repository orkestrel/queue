# @orkestrel/queue

A concurrent, cooperative typed **FIFO job queue**: `Queue` runs enqueued
inputs through a handler under bounded concurrency, with retries and a
per-attempt timeout / abort — each `enqueue` returns a promise that settles
with the job's result. Idle worker loops **park** on a wake list instead of
busy-polling, so an idle queue burns zero CPU; `enqueue` / `resume` wake
exactly one (or all) parked loops. Cancellation is built on the L1 abort +
timeout primitives, so an attempt that ignores its `signal` still fails when
the per-attempt deadline runs out. Durability is opt-in and outstanding-only —
pass a `store` and a `restore()` after a restart re-runs precisely the
unfinished work; `DatabaseQueueStore` persists over any driver, and
`MemoryQueueStore` is the zero-plumbing in-process default. The queue is
observable (a typed `emitter` surfaces `enqueue` / `start` / `retry` /
`success` / `failure` / `abort` / `drain`) and deliberately de-bloated — no
scheduler, no priorities. Environment-agnostic — no I/O, no browser or server
assumptions. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/queue
```

## Requirements

- Node.js >= 24
- ESM-only (no CommonJS build)

## Usage

```ts
import { createQueue } from '@orkestrel/queue'

const queue = createQueue<string, number>({
	handler: async (url, { signal }) => (await fetch(url, { signal })).status,
	concurrency: 4, // up to four in flight at once (default 1 = ordered)
	retries: 2, // two extra attempts on failure
	timeout: 5_000, // each attempt is bounded to 5s
})

const status = await queue.enqueue('https://example.com')
```

## Guide

For the full surface — the `Queue` engine, options, the durable
`QueueStoreInterface` (`MemoryQueueStore` / `DatabaseQueueStore`), the
observable `emitter`, and usage patterns — see
[`guides/src/queue.md`](guides/src/queue.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
