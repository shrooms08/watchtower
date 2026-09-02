import { ModelMessageItem, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { resolveRuntime } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";

export class OwnAnswerSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return context.event.type === "model.answer" && context.event.producerId === context.participant.getId();
	}
}

/** The acknowledgement the report checks for after a rejected call. */
export class RecordAckProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const { answer } = context.event.payload as { answer: ModelMessageItem };
		const text = answer.content.text.trim();

		resolveRuntime().state.responderAcks.push({ ts: Date.now(), text });
		console.log(`[responder] ${text.replace(/\s+/g, " ")}`);
	}
}

export const ownAnswerHandler: SituationHandler = {
	specification: new OwnAnswerSpecification(),
	processor: new RecordAckProcessor(),
};
