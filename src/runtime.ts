import { defineRuntime, RuntimeState } from "@mozaik-ai/core";
import type { ChainEventPayload, EventKind } from "./chain-event";

/** Hard global cap on how many runLoop calls the whole run may make. */
export class InferenceBudget {
	used = 0;

	constructor(public readonly max: number) {}

	tryConsume(): boolean {
		if (this.used >= this.max) {
			return false;
		}

		this.used++;
		return true;
	}

	remaining(): number {
		return this.max - this.used;
	}
}

export type Incident = {
	id: string;
	eventId: string;
	chain: string;
	source: string;
	kind: string;
	summary: string;
	severity: "low" | "medium" | "high" | "unknown";
	correlated: boolean;
};

export type LoggedEvent = {
	ts: number;
	type: string;
	producer: string;
};

export class EnvironmentState extends RuntimeState {
	readonly incidents: Incident[] = [];
	readonly eventLog: LoggedEvent[] = [];
	/** eventId -> the event that was sent for analysis, for exact correlation. */
	readonly analysedEvents = new Map<string, ChainEventPayload>();
	readonly chainEventKinds = new Map<EventKind, number>();
	brief = "(no brief yet)";
	analystId = "";
	lastInferenceActivity = Date.now();
	chainEventsSeen = 0;
	skippedNormalCount = 0;
	dispatchedCount = 0;
	budgetBlockedCount = 0;
	parseFailureCount = 0;
	invalidPayloadCount = 0;

	constructor(public readonly inferenceBudget: InferenceBudget) {
		super();
	}

	static create(maxInferences: number): EnvironmentState {
		return new EnvironmentState(new InferenceBudget(maxInferences));
	}

	inFlight(): number {
		let n = 0;

		for (const entry of this.eventLog) {
			if (entry.type === "inference.started") n++;
			if (entry.type === "inference.completed") n--;
		}

		return n;
	}
}

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
	defineRuntime<EnvironmentState>();
