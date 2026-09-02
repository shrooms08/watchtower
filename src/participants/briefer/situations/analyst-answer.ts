import { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isolatedInput } from "../../../agent-context";
import { resolveRuntime, runLoop } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";

/**
 * Only the Risk Analyst's answers, never the briefer's own - otherwise every
 * brief would trigger another brief.
 */
export class AnalystAnsweredSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
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

export class RewriteBriefProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const agent = context.participant as Agent;
		const { incidents } = resolveRuntime().state;
		const summary = incidents.map(({ eventId, source, kind, severity, summary: reason }) => ({
			eventId,
			source,
			kind,
			severity,
			reason,
		}));

		runLoop(
			agent.getId(),
			`Incidents so far: ${JSON.stringify(summary)}. Rewrite the ops brief in under 40 words, grouped by source stream.`,
			isolatedInput(agent, 160),
		);
	}
}

export const analystAnsweredHandler: SituationHandler = {
	specification: new AnalystAnsweredSpecification(),
	processor: new RewriteBriefProcessor(),
};
