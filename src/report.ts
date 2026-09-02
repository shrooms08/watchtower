import type { LoggedEvent } from "./runtime";

export type Interval = {
	producer: string;
	startedAt: number;
	completedAt: number | undefined;
};

export type Overlap = {
	a: Interval;
	b: Interval;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Peak concurrency, swept in log order: +1 per inference.started, -1 per
 * inference.completed. Exact - it needs no pairing.
 */
export function peakConcurrency(eventLog: readonly LoggedEvent[]): number {
	let active = 0;
	let peak = 0;

	for (const entry of eventLog) {
		if (entry.type === "inference.started") {
			active++;
			peak = Math.max(peak, active);
		}

		if (entry.type === "inference.completed") {
			active--;
		}
	}

	return peak;
}

/**
 * Pair starts with completions per producer, oldest first. inference.* events
 * carry no loop id, so when one producer has two loops in flight the pairing of
 * a specific start to a specific completion is by arrival order.
 */
export function inferenceIntervals(eventLog: readonly LoggedEvent[]): Interval[] {
	const intervals: Interval[] = [];
	const open = new Map<string, Interval[]>();

	for (const entry of eventLog) {
		if (entry.type === "inference.started") {
			const interval: Interval = { producer: entry.producer, startedAt: entry.ts, completedAt: undefined };
			intervals.push(interval);
			open.set(entry.producer, [...(open.get(entry.producer) ?? []), interval]);
		}

		if (entry.type === "inference.completed") {
			const queue = open.get(entry.producer) ?? [];
			const interval = queue.shift();
			open.set(entry.producer, queue);

			if (interval) {
				interval.completedAt = entry.ts;
			}
		}
	}

	return intervals;
}

/** Every pair where B started before A completed. */
export function overlaps(intervals: readonly Interval[]): Overlap[] {
	const found: Overlap[] = [];

	for (let i = 0; i < intervals.length; i++) {
		for (let j = i + 1; j < intervals.length; j++) {
			const a = intervals[i]!;
			const b = intervals[j]!;
			const aEnd = a.completedAt ?? Number.POSITIVE_INFINITY;

			if (b.startedAt < aEnd) {
				found.push({ a, b });
			}
		}
	}

	return found;
}

export function formatOverlap({ a, b }: Overlap): string {
	const aEnd = a.completedAt === undefined ? "still in flight" : iso(a.completedAt);

	return (
		`  ${b.producer} started ${iso(b.startedAt)} while ${a.producer} was in flight ` +
		`(started ${iso(a.startedAt)}, completed ${aEnd})`
	);
}

/** Shared GUARDRAIL section for the proof, live and drill reports. */
export function printGuardrailSection(state: {
	pendingApprovals: Map<string, { pendingId: string; incidentId: string; action: string; target: string }>;
	decisions: readonly { pendingId: string; incidentId: string; decision: string; by: string; ts: string }[];
	actions: readonly { incidentId: string; action: string; target: string; status: string; ts: string }[];
	responderAcks: readonly { ts: number; text: string }[];
}): void {
	console.log("--- guardrail ---");
	console.log(`Pending approvals raised:  ${state.pendingApprovals.size}`);
	console.log(`Decisions:                 ${state.decisions.length}`);

	for (const decision of state.decisions) {
		console.log(
			`  ${decision.pendingId} incident=${decision.incidentId} ${decision.decision} by=${decision.by} at ${decision.ts}`,
		);
	}

	console.log(`Actions executed:          ${state.actions.length}`);

	for (const action of state.actions) {
		console.log(`  ${action.incidentId} ${action.action} -> ${action.target} (${action.status}, simulated) at ${action.ts}`);
	}

	const rejected = state.decisions.filter((decision) => decision.decision === "rejected");

	console.log(`Rejected calls:            ${rejected.length}`);

	for (const decision of rejected) {
		const decidedAt = Date.parse(decision.ts);
		const ack = state.responderAcks.find((entry) => entry.ts >= decidedAt);

		console.log(
			`  ${decision.pendingId} responder acknowledged: ${ack ? `yes - "${ack.text.replace(/\s+/g, " ")}"` : "no"}`,
		);
	}
}

/** True when every rejected call was followed by a Responder answer. */
export function allRejectionsAcknowledged(state: {
	decisions: readonly { decision: string; ts: string }[];
	responderAcks: readonly { ts: number }[];
}): boolean {
	const rejected = state.decisions.filter((decision) => decision.decision === "rejected");

	return rejected.every((decision) => state.responderAcks.some((ack) => ack.ts >= Date.parse(decision.ts)));
}
