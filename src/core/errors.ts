import type { QueueErrorContext, QueueErrorOptions } from './types.js'

/**
 * Represents a queue failure carrying a lowercase machine-readable `code`, optional
 * structured context, and an optional cause.
 *
 * @example
 * ```ts
 * new QueueError('duplicate id', { code: 'duplicate', context: { id: 'job-1' } })
 * ```
 */
export class QueueError extends Error {
	override readonly name = 'QueueError'
	readonly code
	readonly context: QueueErrorContext | undefined

	/**
	 * Creates a queue error.
	 *
	 * @param message - Human-readable failure description
	 * @param options - Machine-readable category, optional context, and optional cause
	 */
	constructor(message: string, options: QueueErrorOptions) {
		const cause = options.cause
		super(message, cause === undefined ? undefined : { cause })
		this.code = options.code
		this.context = options.context === undefined ? undefined : Object.freeze({ ...options.context })
	}
}

/**
 * Determines whether an unknown value is a {@link QueueError}, staying total for a hostile
 * value.
 *
 * @param value - The value to inspect
 * @returns True if the value is a real `QueueError` instance; false otherwise, including for
 *   a hostile value
 *
 * @example
 * ```ts
 * try {
 * 	await queue.clear()
 * } catch (error) {
 * 	if (isQueueError(error) && error.code === 'cleanup') report(error.context)
 * }
 * ```
 */
export function isQueueError(value: unknown): value is QueueError {
	try {
		return value instanceof QueueError
	} catch {
		return false
	}
}
