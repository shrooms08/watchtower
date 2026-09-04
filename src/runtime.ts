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
	/** Epoch ms, so the correlator can take a time window over incidents. */
	ts: number;
};

export type Correlation = {
	id: string;
	incidentIds: string[];
	pattern: string;
	confidence: "low" | "medium" | "high";
	ts: string;
};

export type GuardrailAction = "pause_program" | "freeze_wallet" | "alert_operator";

export type PendingApproval = {
	pendingId: string;
	incidentId: string;
	action: GuardrailAction;
	target: string;
	reason: string;
	ts: string;
};

export type GuardrailDecision = {
	pendingId: string;
	incidentId: string;
	decision: "approved" | "rejected";
	by: "operator" | "auto";
	ts: string;
	/** Why it was rejected, surfaced to the model in the function output. */
	note?: string;
};

/** Simulation only - nothing here ever touches a chain. */
export type ExecutedAction = {
	incidentId: string;
	action: GuardrailAction;
	target: string;
	reason: string;
	status: "executed";
	ts: string;
};

export type OperatorAnswer = {
	question: string;
	answer: string;
	ts: string;
};

export type ResponderAck = {
	ts: number;
	text: string;
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
	readonly pendingApprovals = new Map<string, PendingApproval>();
	readonly decisions: GuardrailDecision[] = [];
	readonly actions: ExecutedAction[] = [];
	readonly responderAcks: ResponderAck[] = [];
	readonly correlations: Correlation[] = [];
	/** Sorted-id keys of incident sets already sent to the correlator. */
	readonly correlatorSeen = new Set<string>();
	correlatorLastRunTs = 0;
	brieferLastRunTs = 0;
	brieferDirty = false;
	/** Brief loops (not question loops) currently awaiting an answer. */
	brieferBriefsInFlight = 0;
	readonly pendingOperatorQuestions: string[] = [];
	readonly operatorAnswers: OperatorAnswer[] = [];
	/** Analyst dispatch timestamps, for the rolling per-minute limit. */
	readonly analystRuns: number[] = [];
	/** Infinity outside the server: the scripts are bounded by the budget alone. */
	analystPerMin = Number.POSITIVE_INFINITY;
	analystRateLimitedCount = 0;
	/**
	 * Set by whoever owns the watcher handles (the server). Kept as a function so
	 * the runtime never has to import the watcher module.
	 */
	watcherStatsProvider: (() => unknown[]) | undefined;
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

	static create(maxInferences: number, analystPerMin?: number): EnvironmentState {
		const state = new EnvironmentState(new InferenceBudget(maxInferences));

		if (analystPerMin !== undefined && Number.isFinite(analystPerMin)) {
			state.analystPerMin = analystPerMin;
		}

		return state;
	}

	watcherStats(): unknown[] {
		return this.watcherStatsProvider?.() ?? [];
	}

	/** Rolling 60s window. Claims a slot when it returns true. */
	analystMayRun(now: number = Date.now()): boolean {
		while (this.analystRuns.length > 0 && now - this.analystRuns[0]! > 60_000) {
			this.analystRuns.shift();
		}

		if (this.analystRuns.length >= this.analystPerMin) {
			return false;
		}

		this.analystRuns.push(now);
		return true;
	}

	analystUsedThisMinute(now: number = Date.now()): number {
		return this.analystRuns.filter((ts) => now - ts <= 60_000).length;
	}

	addPending(pending: PendingApproval): void {
		this.pendingApprovals.set(pending.pendingId, pending);
	}

	getPending(pendingId: string): PendingApproval | undefined {
		return this.pendingApprovals.get(pendingId);
	}

	/** Records a decision once; later calls for the same pendingId are ignored. */
	resolvePending(decision: GuardrailDecision): boolean {
		if (this.decisions.some((existing) => existing.pendingId === decision.pendingId)) {
			return false;
		}

		this.decisions.push(decision);
		return true;
	}

	decisionFor(pendingId: string): GuardrailDecision | undefined {
		return this.decisions.find((decision) => decision.pendingId === pendingId);
	}

	recordAction(action: ExecutedAction): void {
		this.actions.push(action);
	}

	/** Incidents recorded within `windowMs` of now, newest last. */
	incidentsInWindow(windowMs: number, now: number = Date.now()): Incident[] {
		return this.incidents.filter((incident) => now - incident.ts <= windowMs);
	}

	recordCorrelation(correlation: Correlation): void {
		this.correlations.push(correlation);
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
