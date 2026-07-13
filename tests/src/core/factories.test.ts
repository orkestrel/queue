import { describe, expect, it } from 'vitest'
import { stringShape } from '@orkestrel/contract'
import { createMemoryDriver } from '@orkestrel/database'
import { createDatabaseQueueStore, createMemoryQueueStore, createQueue } from '@src/core'
import { createRecorder } from '../../setup.js'

// src/core/workers/factories.ts — createQueue / createPool / createWorker each wire up
// a working, typed interface end to end (AGENTS §16).

describe('createQueue', () => {
	it('returns a working queue that runs the handler and resolves', async () => {
		const queue = createQueue<number, number>({ handler: (input) => input + 1 })
		await expect(queue.enqueue(41)).resolves.toBe(42)
	})

	it('honours concurrency, retries, and a default timeout', async () => {
		const attempts = createRecorder<[]>()
		const queue = createQueue<undefined, string>({
			concurrency: 2,
			retries: 1,
			timeout: 1_000,
			handler: () => {
				attempts.handler()
				if (attempts.count < 2) throw new Error('retry me')
				return 'done'
			},
		})
		await expect(queue.enqueue(undefined)).resolves.toBe('done')
		expect(attempts.count).toBe(2)
	})

	it('exposes the live status surface (count / active / paused / stopped)', async () => {
		const queue = createQueue<number, number>({ handler: (input) => input })
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
		expect(queue.paused).toBe(false)
		expect(queue.stopped).toBe(false)

		queue.pause()
		const pending = queue.enqueue(1)
		expect(queue.paused).toBe(true)
		expect(queue.count).toBe(1)

		queue.stop()
		await expect(pending).rejects.toThrow('stopped')
		expect(queue.stopped).toBe(true)
	})
})

describe('createDatabaseQueueStore', () => {
	it('returns a working store over an injected driver that round-trips entries', async () => {
		const store = createDatabaseQueueStore(stringShape(), createMemoryDriver())
		await store.save({ id: 'job-1', input: 'task', attempts: 0 })
		const outstanding = await store.load()
		expect(outstanding).toEqual([{ id: 'job-1', input: 'task', attempts: 0 }])
	})
})

describe('createMemoryQueueStore', () => {
	it('returns a working memory-backed store that round-trips entries', async () => {
		const store = createMemoryQueueStore(stringShape())
		await store.save({ id: 'job-1', input: 'task', attempts: 0 })
		await store.save({ id: 'job-2', input: 'other', attempts: 1 })
		const outstanding = await store.load()
		expect(outstanding.map((entry) => entry.id)).toEqual(['job-1', 'job-2'])
		expect(outstanding[1]).toEqual({ id: 'job-2', input: 'other', attempts: 1 })
	})
})
