import type { StoredEntry } from './types.js'
import { isFiniteNumber, isInteger, isRecord, isString } from '@orkestrel/contract'
import { MAX_TIMEOUT_MS } from '@orkestrel/timeout'

/**
 * Determines whether a value is a valid queue concurrency — a positive safe integer.
 *
 * @param value - Value to inspect
 * @returns True if the value is a positive safe integer; false otherwise
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
 * Determines whether a value is a valid queue retry count — a nonnegative safe integer.
 *
 * @param value - Value to inspect
 * @returns True if the value is a nonnegative safe integer; false otherwise
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
 * Determines whether a value is a valid queue timeout — an integer count of milliseconds
 * inside the native timer range.
 *
 * @param value - Value to inspect
 * @returns True if the value is an integer within the native timer range,
 *   inclusive; false otherwise
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
 * Determines whether a value is a native abort signal usable by the queue, testing the
 * native brand rather than the shape.
 *
 * @param value - Value to inspect
 * @returns True if the value carries the native `AbortSignal` internal slot; false otherwise
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
 * Determines whether a value is a valid stored queue entry — a record holding a string
 * `id`, an `input`, and a nonnegative safe-integer `attempts`.
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
