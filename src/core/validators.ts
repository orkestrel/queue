import type { StoredEntry } from './types.js'
import { isFiniteNumber, isInteger, isRecord, isString } from '@orkestrel/contract'
import { MAX_TIMEOUT_MS } from '@orkestrel/timeout'

/**
 * Determine whether a value is a valid queue concurrency.
 *
 * @param value - Value to inspect
 * @returns Whether the value is a positive safe integer
 *
 * @example
 * ```ts
 * isQueueConcurrency(4) // true
 * isQueueConcurrency(0) // false
 * ```
 */
export function isQueueConcurrency(value: unknown): value is number {
	return isInteger(value) && Number.isSafeInteger(value) && value > 0
}

/**
 * Determine whether a value is a valid queue retry count.
 *
 * @param value - Value to inspect
 * @returns Whether the value is a nonnegative safe integer
 *
 * @example
 * ```ts
 * isQueueRetries(2) // true
 * isQueueRetries(-1) // false
 * ```
 */
export function isQueueRetries(value: unknown): value is number {
	return isInteger(value) && Number.isSafeInteger(value) && value >= 0
}

/**
 * Determine whether a value is a valid queue timeout.
 *
 * @param value - Value to inspect
 * @returns Whether the value is an integer within the native timer range, inclusive
 *
 * @example
 * ```ts
 * isQueueTimeout(500) // true
 * isQueueTimeout(2_147_483_648) // false
 * ```
 */
export function isQueueTimeout(value: unknown): value is number {
	return isFiniteNumber(value) && isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS
}

/**
 * Determine whether a value is a native abort signal usable by the queue.
 *
 * @param value - Value to inspect
 * @returns Whether the value carries the native `AbortSignal` internal slot
 *
 * @example
 * ```ts
 * isQueueSignal(new AbortController().signal) // true
 * isQueueSignal({}) // false
 * ```
 */
export function isQueueSignal(value: unknown): value is AbortSignal {
	try {
		const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
		if (getter === undefined) return false
		Reflect.apply(getter, value, [])
		return true
	} catch {
		return false
	}
}

/**
 * Checks whether a value is a valid stored queue entry.
 *
 * @remarks
 * The single test for what a {@link StoredEntry} is, shared by the queue's `restore`
 * boundary and the memory store's `save` boundary. `input` carries the caller's own
 * payload type, so only its presence is checked.
 *
 * @param value - Value to inspect
 * @returns True if the value is a record holding a string `id`, an `input` member, and a
 *   nonnegative safe-integer `attempts`; false otherwise
 *
 * @example
 * ```ts
 * isStoredEntry({ id: 'job-1', input: 'task', attempts: 0 }) // true
 * isStoredEntry({ id: 'job-1', input: 'task', attempts: -1 }) // false
 * ```
 */
export function isStoredEntry(value: unknown): value is StoredEntry<unknown> {
	try {
		if (!isRecord(value)) return false
		return isString(value.id) && 'input' in value && isQueueRetries(value.attempts)
	} catch {
		return false
	}
}
