import { isFiniteNumber, isInteger } from '@orkestrel/contract'

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
	return isFiniteNumber(value) && isInteger(value) && value >= 0 && value <= 2_147_483_647
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
