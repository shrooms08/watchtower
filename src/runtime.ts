import { defineRuntime, RuntimeState } from "@mozaik-ai/core";

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
	chain: string;
	summary: string;
	severity: "low" | "medium" | "high" | "unknown";
};

export type LoggedEvent = {
	ts: number;
	type: string;
	producer: string;
};

/** What the analyst dispatched, so an answer can be matched back to a chain. */
export type PendingAnalysis = {
	chain: string;
	txSig: string;
	kind: string;
};

export class EnvironmentState extends RuntimeState {
	readonly incidents: Incident[] = [];
	readonly eventLog: LoggedEvent[] = [];
	readonly pendingAnalyses: PendingAnalysis[] = [];
	brief = "(no brief yet)";
	chainEventsSeen = 0;
	skippedNormalCount = 0;
	dispatchedCount = 0;
	budgetBlockedCount = 0;
	analystId = "";
	lastInferenceActivity = Date.now();

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
