import type { ContractInterface, ContractShape, Infer } from '@orkestrel/contract'
import type { QueueStoreInterface, StoredEntry } from '../types.js'
import { cloneJSONValue, createContract, isString } from '@orkestrel/contract'
import { QueueError } from '../errors.js'
import { isQueueRetries } from '../validators.js'

/**
 * An in-memory store owning validated, immutable JSON snapshots of outstanding entries.
 *
 * @typeParam TInput - The contract shape for each stored input
 *
 * @example
 * ```ts
 * import { stringShape } from '@orkestrel/contract'
 * import { MemoryQueueStore } from '@orkestrel/queue'
 *
 * const store = new MemoryQueueStore(stringShape())
 * await store.save({ id: 'job-1', input: 'task', attempts: 0 })
 * ```
 */
export class MemoryQueueStore<TInput extends ContractShape> implements QueueStoreInterface<
	Infer<TInput>
> {
	readonly #contract: ContractInterface<Infer<TInput>>
	readonly #entries = new Map<string, StoredEntry<Infer<TInput>>>()

	/**
	 * Create an in-memory queue store.
	 *
	 * @param input - Runtime contract for each stored input
	 */
	constructor(input: TInput) {
		this.#contract = createContract(input)
	}

	/** Upsert a validated, owned snapshot under the entry's id. */
	save(entry: StoredEntry<Infer<TInput>>): Promise<void> {
		try {
			const id: unknown = entry.id
			const input = entry.input
			const attempts: unknown = entry.attempts
			if (!isString(id) || !isQueueRetries(attempts)) {
				throw new QueueError('queue store entry is invalid', {
					code: 'store',
					context: { operation: 'save' },
				})
			}
			this.#entries.set(id, this.#snapshot(id, input, attempts, 'save'))
			return Promise.resolve()
		} catch (error: unknown) {
			return Promise.reject(
				new QueueError('queue store save failed', {
					code: 'store',
					cause: error,
					context: { operation: 'save' },
				}),
			)
		}
	}

	/** Remove an entry; an absent id is a no-op. */
	remove(id: string): Promise<void> {
		this.#entries.delete(id)
		return Promise.resolve()
	}

	/** Return fresh immutable snapshots of every outstanding entry. */
	load(): Promise<ReadonlyArray<StoredEntry<Infer<TInput>>>> {
		try {
			const snapshots: Array<StoredEntry<Infer<TInput>>> = []
			for (const entry of this.#entries.values()) {
				const id = entry.id
				const input = entry.input
				const attempts = entry.attempts
				snapshots.push(this.#snapshot(id, input, attempts, 'load'))
			}
			return Promise.resolve(snapshots)
		} catch (error: unknown) {
			return Promise.reject(
				new QueueError('queue store load failed', {
					code: 'store',
					cause: error,
					context: { operation: 'load' },
				}),
			)
		}
	}

	/** Remove every outstanding entry. */
	clear(): Promise<void> {
		this.#entries.clear()
		return Promise.resolve()
	}

	#snapshot(
		id: string,
		input: Infer<TInput>,
		attempts: number,
		operation: 'save' | 'load',
	): StoredEntry<Infer<TInput>> {
		const snapshot = cloneJSONValue(input)
		if (!this.#contract.is(snapshot)) {
			throw new QueueError('queue store input does not satisfy its contract', {
				code: 'store',
				context: { id, operation },
			})
		}
		return Object.freeze({ id, input: snapshot, attempts })
	}
}
