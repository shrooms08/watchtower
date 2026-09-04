import { Agent } from "@mozaik-ai/core";
import { isolatedInput } from "../../agent-context";
import { MODEL_BRIEFER } from "../../models";
import { resolveRuntime, runLoop } from "../../runtime";

/** At most one brief every 8s; anything arriving inside the window coalesces. */
export const BRIEFER_MIN_INTERVAL_MS = 8_000;

/** At most one pending catch-up timer, and the agent to run it with. */
let pendingRerun: ReturnType<typeof setTimeout> | undefined;
let lastAgent: Agent | undefined;

/**
 * A trigger can be rate limited while no brief is in flight - a guardrail
 * decision landing seconds after the last brief finished, say. The dirty flag
 * would then have nothing to drain it, so schedule one catch-up run at the end
 * of the window. Still a single coalesced rerun: one timer, cancelled by
 * whichever path runs first.
 */
function scheduleCoalescedRerun(): void {
	if (pendingRerun) {
		return;
	}

	const state = resolveRuntime().state;
	const wait = Math.max(0, BRIEFER_MIN_INTERVAL_MS - (Date.now() - state.brieferLastRunTs)) + 50;

	pendingRerun = setTimeout(() => {
		pendingRerun = undefined;

		const current = resolveRuntime().state;

		if (!current.brieferDirty || !lastAgent) {
			return;
		}

		current.brieferDirty = false;

		if (!current.inferenceBudget.tryConsume()) {
			console.log("[briefer] coalesced rerun skipped - budget exhausted");
			return;
		}

		current.brieferLastRunTs = Date.now();
		console.log("[briefer] coalesced rerun (rate window elapsed)");
		runBrief(lastAgent, "Triggers arrived while the brief was rate limited.");
	}, wait);

	pendingRerun.unref?.();
}

/**
 * The rate gate, called from a specification so the reservation and the
 * decision happen together. Returns false and marks the state dirty when the
 * trigger lands inside the window - the pending answer's handler will then run
 * exactly one more brief with whatever the state looks like by then.
 */
export function brieferMayRun(trigger: string): boolean {
	const state = resolveRuntime().state;
	const sinceLast = Date.now() - state.brieferLastRunTs;

	if (sinceLast < BRIEFER_MIN_INTERVAL_MS) {
		state.brieferDirty = true;
		console.log(`[briefer] rate limited (${sinceLast}ms < ${BRIEFER_MIN_INTERVAL_MS}ms) - coalescing ${trigger}`);
		scheduleCoalescedRerun();
		return false;
	}

	const budget = state.inferenceBudget;

	if (!budget.tryConsume()) {
		console.log(`[briefer] budget exhausted (${budget.used}/${budget.max}) - brief not refreshed`);
		return false;
	}

	state.brieferLastRunTs = Date.now();
	return true;
}

/** Everything the brief is allowed to talk about, always the latest state. */
function briefPayload(): {
	incidents: unknown[];
	decisions: unknown[];
	correlations: unknown[];
} {
	const state = resolveRuntime().state;

	return {
		incidents: state.incidents.map(({ id, source, kind, severity, summary }) => ({
			id,
			source,
			kind,
			severity,
			reason: summary,
		})),
		decisions: state.decisions.map(({ pendingId, incidentId, decision, by }) => ({
			pendingId,
			incidentId,
			decision,
			by,
		})),
		correlations: state.correlations.map(({ id, incidentIds, pattern, confidence }) => ({
			id,
			incidentIds,
			pattern,
			confidence,
		})),
	};
}

/**
 * Addenda are driven by state, not only by the trigger, so a brief written for
 * one reason still states a decision or a link that already exists. Without
 * that, the last brief to run could silently drop the thing a reader needs.
 */
export function runBrief(agent: Agent, lead: string): void {
	lastAgent = agent;

	const state = resolveRuntime().state;
	const payload = briefPayload();
	const addenda: string[] = [];

	if (state.correlations.length > 0) {
		addenda.push("Lead the brief with the linked pattern.");
	}

	if (state.decisions.length > 0) {
		addenda.push("State the operator's decision explicitly in the brief.");
	}

	const limit = addenda.length > 0 ? 60 : 40;
	const message =
		`${lead}\n` +
		`State: ${JSON.stringify(payload)}\n` +
		`Rewrite the ops brief in under ${limit} words, grouped by source stream. ${addenda.join(" ")}`.trim();

	runLoop(agent.getId(), message, isolatedInput(agent, MODEL_BRIEFER, 260));
}
