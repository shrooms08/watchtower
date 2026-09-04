import { ModelMessageItem, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { parseVerdict } from "../../../chain-event";
import { resolveRuntime } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";

export class OwnAnswerSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return context.event.type === "model.answer" && context.event.producerId === context.participant.getId();
	}
}

export class RecordIncidentProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const { answer } = context.event.payload as { answer: ModelMessageItem };
		const state = resolveRuntime().state;
		const text = answer.content.text.trim();
		const verdict = parseVerdict(text);
		const id = `INC-${String(state.incidents.length + 1).padStart(3, "0")}`;

		if (!verdict) {
			state.parseFailureCount++;
			console.warn(`[analyst] could not parse verdict JSON, recording severity unknown: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
			state.incidents.push({
				id,
				eventId: "unparsed",
				chain: "unknown",
				source: "unknown",
				kind: "unknown",
				summary: text,
				severity: "unknown",
				correlated: false,
				ts: Date.now(),
			});
			return;
		}

		// Matched by eventId, never by order.
		const source = state.analysedEvents.get(verdict.eventId);

		if (!source) {
			console.warn(`[analyst] verdict for unknown eventId ${verdict.eventId}`);
		}

		state.incidents.push({
			id,
			eventId: verdict.eventId,
			chain: source?.chain ?? "unknown",
			source: source?.source ?? "unknown",
			kind: source?.kind ?? "unknown",
			summary: verdict.reason,
			severity: verdict.severity,
			correlated: source !== undefined,
			ts: Date.now(),
		});

		console.log(
			`[analyst] ${id} eventId=${verdict.eventId} correlated=${source !== undefined} severity=${verdict.severity}: ${verdict.reason}`,
		);
	}
}

export const ownAnswerHandler: SituationHandler = {
	specification: new OwnAnswerSpecification(),
	processor: new RecordIncidentProcessor(),
};
