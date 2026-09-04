import { ModelMessageItem, SemanticEvent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { parseCorrelation, type CorrelationFoundPayload } from "../../../correlation";
import { resolveRuntime, sendEvent } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";

export class OwnAnswerSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return context.event.type === "model.answer" && context.event.producerId === context.participant.getId();
	}
}

export class RecordCorrelationProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const { answer } = context.event.payload as { answer: ModelMessageItem };
		const state = resolveRuntime().state;
		const verdict = parseCorrelation(answer.content.text);

		if (!verdict) {
			state.parseFailureCount++;
			console.warn(`[correlator] could not parse correlation JSON: ${answer.content.text.replace(/\s+/g, " ").slice(0, 120)}`);
			return;
		}

		if (!verdict.linked) {
			console.log("[correlator] no link");
			return;
		}

		const payload: CorrelationFoundPayload = {
			id: `COR-${String(state.correlations.length + 1).padStart(3, "0")}`,
			incidentIds: verdict.incidentIds,
			pattern: verdict.pattern,
			confidence: verdict.confidence,
			ts: new Date().toISOString(),
		};

		state.recordCorrelation(payload);
		sendEvent(SemanticEvent.create("correlation.found", context.participant.getId(), payload), context.participant.getId());

		console.log(`[correlator] ${payload.id} [${payload.confidence}] ${payload.incidentIds.join(" + ")}: ${payload.pattern}`);
	}
}

export const ownAnswerHandler: SituationHandler = {
	specification: new OwnAnswerSpecification(),
	processor: new RecordCorrelationProcessor(),
};
