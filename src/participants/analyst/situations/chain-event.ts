import {
	Agent,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core";
import { isolatedInput } from "../../../agent-context";
import { resolveRuntime, runLoop } from "../../../runtime";
import type { ChainEventPayload } from "../../watcher";

/**
 * Risky events only, and only while the global budget allows. tryConsume() runs
 * here (not in the processor) so the reservation happens at the same moment the
 * decision is made - two events arriving together cannot both claim the last slot.
 */
export class RiskyChainEventSpecification extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		if (context.event.type !== "chain.event") {
			return false;
		}

		const payload = context.event.payload as ChainEventPayload;

		if (payload.kind === "normal") {
			return false;
		}

		const state = resolveRuntime().state;
		const budget = state.inferenceBudget;

		if (!budget.tryConsume()) {
			state.budgetBlockedCount++;
			console.log(`[analyst] budget exhausted (${budget.used}/${budget.max}) - logging ${payload.kind}, no inference`);
			return false;
		}

		return true;
	}
}

export class AnalyseEventProcessor implements SituationProcessor {
	apply(context: SituationContext): void {
		const agent = context.participant as Agent;
		const payload = context.event.payload as ChainEventPayload;
		const state = resolveRuntime().state;

		state.pendingAnalyses.push({ chain: payload.chain, txSig: payload.txSig, kind: payload.kind });
		state.dispatchedCount++;

		// Its own loop per event - never queued behind the previous one.
		runLoop(agent.getId(), `Event: ${JSON.stringify(payload)}`, isolatedInput(agent, 120));
	}
}

export const riskyChainEventHandler: SituationHandler = {
	specification: new RiskyChainEventSpecification(),
	processor: new AnalyseEventProcessor(),
};

export class NormalChainEventSpecification extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return context.event.type === "chain.event" && (context.event.payload as ChainEventPayload).kind === "normal";
	}
}

export class SkipNormalEventProcessor implements SituationProcessor {
	apply(context: SituationContext): void {
		const payload = context.event.payload as ChainEventPayload;

		resolveRuntime().state.skippedNormalCount++;
		console.log(`[analyst] skipped normal event (${payload.chain} ${payload.txSig.slice(0, 10)}...)`);
	}
}

export const normalChainEventHandler: SituationHandler = {
	specification: new NormalChainEventSpecification(),
	processor: new SkipNormalEventProcessor(),
};
