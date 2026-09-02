import {
	Agent,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core";
import { isolatedInput } from "../../../agent-context";
import { resolveRuntime, runLoop } from "../../../runtime";

/**
 * Only the Risk Analyst's answers, never the briefer's own - otherwise every
 * brief would trigger another brief.
 */
export class AnalystAnsweredSpecification extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		if (context.event.type !== "model.answer") {
			return false;
		}

		const state = resolveRuntime().state;

		if (context.event.producerId !== state.analystId) {
			return false;
		}

		const budget = state.inferenceBudget;

		if (!budget.tryConsume()) {
			console.log(`[briefer] budget exhausted (${budget.used}/${budget.max}) - brief not refreshed`);
			return false;
		}

		return true;
	}
}

export class RewriteBriefProcessor implements SituationProcessor {
	apply(context: SituationContext): void {
		const agent = context.participant as Agent;
		const { incidents } = resolveRuntime().state;

		runLoop(
			agent.getId(),
			`Incidents so far: ${JSON.stringify(incidents)}. Rewrite the ops brief in under 40 words.`,
			isolatedInput(agent, 160),
		);
	}
}

export const analystAnsweredHandler: SituationHandler = {
	specification: new AnalystAnsweredSpecification(),
	processor: new RewriteBriefProcessor(),
};
