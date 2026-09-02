import {
	ModelMessageItem,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core";
import { resolveRuntime } from "../../../runtime";
import type { Incident } from "../../../runtime";

export class OwnAnswerSpecification extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return context.event.type === "model.answer" && context.event.producerId === context.participant.getId();
	}
}

function parseSeverity(text: string): Incident["severity"] {
	const match = /severity\s*:\s*(low|medium|high)/i.exec(text);

	return match ? (match[1]!.toLowerCase() as Incident["severity"]) : "unknown";
}

export class RecordIncidentProcessor implements SituationProcessor {
	apply(context: SituationContext): void {
		const { answer } = context.event.payload as { answer: ModelMessageItem };
		const state = resolveRuntime().state;
		// model.answer carries no loop id, so concurrent analyses can only be
		// matched back to their event in dispatch order. See MOZAIK-NOTES.md.
		const pending = state.pendingAnalyses.shift();
		const text = answer.content.text.trim();

		state.incidents.push({
			id: `INC-${String(state.incidents.length + 1).padStart(3, "0")}`,
			chain: pending?.chain ?? "unknown",
			summary: text,
			severity: parseSeverity(text),
		});

		console.log(`[analyst] incident recorded (${state.incidents.length} total): ${text.replace(/\s+/g, " ")}`);
	}
}

export const ownAnswerHandler: SituationHandler = {
	specification: new OwnAnswerSpecification(),
	processor: new RecordIncidentProcessor(),
};
