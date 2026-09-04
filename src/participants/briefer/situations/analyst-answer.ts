import { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { resolveRuntime } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";
import { brieferMayRun, runBrief } from "../brief";

/**
 * Only the Risk Analyst's answers, never the briefer's own - otherwise every
 * brief would trigger another brief.
 */
export class AnalystAnsweredSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		if (context.event.type !== "model.answer") {
			return false;
		}

		if (context.event.producerId !== resolveRuntime().state.analystId) {
			return false;
		}

		return brieferMayRun("analyst answer");
	}
}

export class RewriteBriefProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		runBrief(context.participant as Agent, "A new incident was assessed.");
	}
}

export const analystAnsweredHandler: SituationHandler = {
	specification: new AnalystAnsweredSpecification(),
	processor: new RewriteBriefProcessor(),
};
