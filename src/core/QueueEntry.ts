import type { QueueEntryOptions } from './types.js'

/** Holds one queue reservation's execution and settlement state. */
export class QueueEntry<TInput> {
	readonly id: string
	readonly input: TInput
	readonly options: QueueEntryOptions | undefined
	#attempts: number
	#settled = false

	constructor(id: string, input: TInput, options: QueueEntryOptions | undefined, attempts: number) {
		this.id = id
		this.input = input
		this.options = options
		this.#attempts = attempts
	}

	get attempts(): number {
		return this.#attempts
	}

	get settled(): boolean {
		return this.#settled
	}

	complete(): number {
		this.#attempts += 1
		return this.#attempts
	}

	settle(): void {
		this.#settled = true
	}
}
