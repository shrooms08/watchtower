import { defineRuntime, RuntimeState } from "@mozaik-ai/core";

/** Shared state: a counter every participant can read and write through the runtime. */
export class EventCounter {
	private count = 0;
	private readonly byType = new Map<string, number>();

	record(type: string): number {
		this.count++;
		this.byType.set(type, (this.byType.get(type) ?? 0) + 1);
		return this.count;
	}

	getCount(): number {
		return this.count;
	}

	summary(): string {
		return [...this.byType.entries()].map(([type, n]) => `${type}=${n}`).join(" ");
	}
}

export class EnvironmentState extends RuntimeState {
	constructor(public readonly events: EventCounter) {
		super();
	}
}

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
	defineRuntime<EnvironmentState>();
