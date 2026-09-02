import { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isolatedInput } from "../../../agent-context";
import { isChainEventPayload } from "../../../chain-event";
import { resolveRuntime, runLoop } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";

/**
 * Risky events only, and only while the global budget allows. tryConsume() runs
 * in the specification so the reservation happens at the moment of the decision
 * (MOZAIK-NOTES.md gotcha 16).
 */
export class RiskyChainEventSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		if (context.event.type !== "chain.event") {
			return false;
		}

		const payload = context.event.payload;

		if (!isChainEventPayload(payload)) {
			return false;
		}

		if (payload.kind === "normal") {
			return false;
		}

		const state = resolveRuntime().state;
		const budget = state.inferenceBudget;

		if (!budget.tryConsume()) {
			state.budgetBlockedCount++;
			console.log(`[analyst] budget exhausted (${budget.used}/${budget.max}) - logged ${payload.kind}, no inference`);
			return false;
		}

		return true;
	}
}

export class AnalyseEventProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const agent = context.participant as Agent;
		const payload = context.event.payload;

		if (!isChainEventPayload(payload)) {
			return;
		}

		const state = resolveRuntime().state;

		// Correlation is by eventId, never by arrival order: model.answer carries
		// no loop id and concurrent loops finish out of order.
		state.analysedEvents.set(payload.eventId, payload);
		state.dispatchedCount++;

		const prompt =
			`eventId: ${payload.eventId}\n` +
			`source: ${payload.source}\n` +
			`event: ${JSON.stringify({
				source: payload.source,
				chain: payload.chain,
				kind: payload.kind,
				txSig: payload.txSig,
				amountUsd: payload.amountUsd,
				amountSol: payload.amountSol,
				wallet: payload.wallet,
				detail: payload.detail,
			})}\n` +
			`Reply ONLY with JSON: {"eventId":"${payload.eventId}","severity":"low"|"medium"|"high","reason":"<one sentence naming the source stream>"}`;

		// Its own loop per event - never queued behind the previous one.
		runLoop(agent.getId(), prompt, isolatedInput(agent, 200));
	}
}

export const riskyChainEventHandler: SituationHandler = {
	specification: new RiskyChainEventSpecification(),
	processor: new AnalyseEventProcessor(),
};

export class NormalChainEventSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return (
			context.event.type === "chain.event" &&
			isChainEventPayload(context.event.payload) &&
			context.event.payload.kind === "normal"
		);
	}
}

export class SkipNormalEventProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const payload = context.event.payload;

		if (!isChainEventPayload(payload)) {
			return;
		}

		resolveRuntime().state.skippedNormalCount++;
		console.log(`[analyst] skipped normal event (${payload.eventId} ${payload.detail})`);
	}
}

export const normalChainEventHandler: SituationHandler = {
	specification: new NormalChainEventSpecification(),
	processor: new SkipNormalEventProcessor(),
};

/** Anything claiming to be a chain.event but not shaped like one. */
export class MalformedChainEventSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return context.event.type === "chain.event" && !isChainEventPayload(context.event.payload);
	}
}

export class IgnoreMalformedProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		resolveRuntime().state.invalidPayloadCount++;
		console.warn(`[analyst] ignored chain.event with unknown payload shape: ${JSON.stringify(context.event.payload)}`);
	}
}

export const malformedChainEventHandler: SituationHandler = {
	specification: new MalformedChainEventSpecification(),
	processor: new IgnoreMalformedProcessor(),
};
