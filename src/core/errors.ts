import type { QueueErrorContext, QueueErrorOptions } from './types.js'
import { holds, INTRINSICS, isError, isFunction, isObject, isString } from '@orkestrel/contract'

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
		INTRINSICS.define(this, Symbol.for('@orkestrel/queue.QueueError'), { value: this })
		this.code = options.code
		this.context = options.context === undefined ? undefined : Object.freeze({ ...options.context })
	}
}

/**
 * Determines whether an unknown value is a {@link QueueError}, staying total for a hostile
 * value.
 *
 * @remarks
 * Recognizes the shared brand and declared members across package copies, including subclasses.
 * Refuses a transparent proxy because its brand holds the target's identity.
 *
 * @param value - The value to inspect
 * @returns True if a branded error or subclass has valid members; false otherwise.
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
	return holds(() => {
		if (!isError(value) || INTRINSICS.prototype(value) === Error.prototype) return false
		const brand = INTRINSICS.describe(value, Symbol.for('@orkestrel/queue.QueueError'))
		if (brand === undefined || brand.value !== value) return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		if (
			code !== 'invalid' &&
			code !== 'duplicate' &&
			code !== 'stopped' &&
			code !== 'aborted' &&
			code !== 'destroyed' &&
			code !== 'cleared' &&
			code !== 'timeout' &&
			code !== 'store' &&
			code !== 'cleanup'
		)
			return false
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		if (context === undefined) return true
		if (!isObject(context) && !isFunction(context)) return false
		const id: unknown = INTRINSICS.reflect.read(context, 'id')
		if (id !== undefined && !isString(id)) return false
		const option: unknown = INTRINSICS.reflect.read(context, 'option')
		if (
			option !== undefined &&
			option !== 'id' &&
			option !== 'concurrency' &&
			option !== 'retries' &&
			option !== 'timeout' &&
			option !== 'signal'
		)
			return false
		const operation: unknown = INTRINSICS.reflect.read(context, 'operation')
		return (
			operation === undefined ||
			operation === 'save' ||
			operation === 'remove' ||
			operation === 'load' ||
			operation === 'clear'
		)
	})
}
