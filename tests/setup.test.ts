// The base setup module (`tests/setup.ts`) owns this workspace's queue-shaped test
// infrastructure: the scripted `QueueStoreInterface` boundary stub, the `StoredEntry`
// builder, the driver-backed store builder, and the emitter event-name table. Every suite
// imports them from there rather than declaring its own copy, so this proof is what keeps
// their behaviour honest.
import { describe, expect, it } from 'vitest'
import { stringShape } from '@orkestrel/contract'
import {
	createDriverQueueStore,
	createStoredEntry,
	createStubStore,
	QUEUE_EVENTS,
} from './setup.js'

describe('createStubStore', () => {
	it('resolves an empty load and a no-op remove with no primitive supplied', async () => {
		const { store, removes } = createStubStore<string>()

		await expect(store.remove('absent')).resolves.toBeUndefined()
		expect(await store.load()).toEqual([])
		expect(removes).toEqual(['absent'])
	})

	it('records a save before the supplied primitive rejects', async () => {
		const { store, saves } = createStubStore<string>({
			save: () => Promise.reject(new Error('store offline')),
		})

		await expect(store.save(createStoredEntry('job-1', 'task'))).rejects.toThrow('store offline')
		expect(saves).toEqual([{ id: 'job-1', input: 'task', attempts: 0 }])
	})

	it('delegates load and clear to the supplied primitives', async () => {
		const cleared: string[] = []
		const { store } = createStubStore<string>({
			load: () => Promise.resolve([createStoredEntry('job-1', 'task', 2)]),
			clear: () => {
				cleared.push('clear')
				return Promise.resolve()
			},
		})

		expect(await store.load()).toEqual([{ id: 'job-1', input: 'task', attempts: 2 }])
		await store.clear()
		expect(cleared).toEqual(['clear'])
	})
})

describe('createStoredEntry', () => {
	it('defaults attempts to 0 and carries the supplied id and input', () => {
		expect(createStoredEntry('job-1', 'task')).toEqual({
			id: 'job-1',
			input: 'task',
			attempts: 0,
		})
	})

	it('keeps a supplied attempt count', () => {
		expect(createStoredEntry('job-1', 'task', 3).attempts).toBe(3)
	})
})

describe('createDriverQueueStore', () => {
	it('round-trips an entry through the driver-backed store', async () => {
		const store = createDriverQueueStore(stringShape())
		await store.save({ id: 'job-1', input: 'task', attempts: 0 })

		const outstanding = await store.load()
		expect(outstanding).toEqual([{ id: 'job-1', input: 'task', attempts: 0 }])
		// The loaded `input` is typed as `string`: a string method compiles with no assertion.
		expect(outstanding[0]?.input.toUpperCase()).toBe('TASK')
	})
})

describe('QUEUE_EVENTS', () => {
	it('lists every QueueEventMap name the emitter suites record', () => {
		expect([...QUEUE_EVENTS]).toEqual([
			'enqueue',
			'start',
			'retry',
			'success',
			'failure',
			'abort',
			'drain',
		])
	})
})
