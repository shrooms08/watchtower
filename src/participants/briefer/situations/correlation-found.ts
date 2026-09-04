import { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isCorrelationFoundPayload } from "../../../correlation";
import { SafeProcessor, SafeSpecification } from "../../../safe";
import { brieferMayRun, runBrief } from "../brief";

export class CorrelationFoundSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		if (context.event.type !== "correlation.found" || !isCorrelationFoundPayload(context.event.payload)) {
			return false;
		}

		return brieferMayRun("correlation found");
	}
}

export class BriefCorrelationProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		if (!isCorrelationFoundPayload(context.event.payload)) {
			return;
		}

		const { id, incidentIds, pattern, confidence } = context.event.payload;

		runBrief(
			context.participant as Agent,
			`Cross-stream link ${id} (${confidence} confidence) across ${incidentIds.join(" + ")}: ${pattern}`,
		);
	}
}

export const correlationFoundHandler: SituationHandler = {
	specification: new CorrelationFoundSpecification(),
	processor: new BriefCorrelationProcessor(),
};
