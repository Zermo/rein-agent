/**
 * Minimal async event stream: a queue + async iterator + final-result promise.
 * (Same shape as pi's EventStream — it's just the right primitive.)
 */
import type { AssistantMessage, AssistantMessageEvent } from "./types.ts";

export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete?: (event: T) => boolean, extractResult?: (event: T) => R) {
		this.isComplete = isComplete ?? (() => false);
		this.extractResult = extractResult ?? ((event) => event as unknown as R);
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;
		if (this.isComplete(event)) {
			this.done = true;
			try {
				this.resolveFinalResult(this.extractResult(event));
			} catch {
				// extraction failed; end() will still settle iteration
			}
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	end(result?: R): void {
		if (this.done) return;
		this.done = true;
		if (result !== undefined) this.resolveFinalResult(result);
		while (this.waiting.length > 0) {
			this.waiting.shift()!({ value: undefined as unknown as T, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) yield this.queue.shift()!;
			else if (this.done) return;
			else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	get finished(): boolean {
		return this.done;
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected final event type");
			},
		);
	}
}
