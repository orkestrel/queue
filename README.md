# @orkestrel/queue

> A concurrent, cooperative FIFO job queue: a bounded-concurrency engine that runs each
> enqueued input through a handler with retries and a per-attempt timeout or abort, and
> hands back one promise per `enqueue` that settles with that job's result.

Create a queue with the `createQueue` function, hand it the handler that does the work, and
await each input's result. Pass a `store` where the unfinished work must survive a restart,
and subscribe to the `emitter` where a logger, a metric, or a trace needs the lifecycle
moments. Environment-agnostic — no I/O, no browser or server assumptions. Part of the
`@orkestrel` line.

## Install

```sh
npm install @orkestrel/queue
```

## Requirements

- Node.js >= 22.12.0
- ESM and CommonJS builds from one entry point

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
[`guides/queue.md`](guides/queue.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
