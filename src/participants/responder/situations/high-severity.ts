import { Agent, ModelMessageItem, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isolatedInput } from "../../../agent-context";
import { parseVerdict } from "../../../chain-event";
import { MODEL_RESPONDER } from "../../../models";
import { resolveRuntime, runLoop } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";
import { GuardrailInterceptionHandler } from "../interception/guardrail";

function verdictFrom(context: SituationContext): ReturnType<typeof parseVerdict> {
	const { answer } = context.event.payload as { answer: ModelMessageItem };

	return parseVerdict(answer.content.text);
}

/** Only the analyst's high-severity verdicts, never the responder's own answers. */
export class HighSeveritySpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		if (context.event.type !== "model.answer") {
			return false;
		}

		const state = resolveRuntime().state;

		if (context.event.producerId !== state.analystId) {
			return false;
		}

		const verdict = verdictFrom(context);

		if (verdict?.severity !== "high") {
			return false;
		}

		const budget = state.inferenceBudget;

		if (!budget.tryConsume()) {
			console.log(`[responder] budget exhausted (${budget.used}/${budget.max}) - no response to ${verdict.eventId}`);
			return false;
		}

		return true;
	}
}

export class RespondProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const agent = context.participant as Agent;
		const state = resolveRuntime().state;
		const verdict = verdictFrom(context);

		if (!verdict) {
			return;
		}

		const incident = state.incidents.find((entry) => entry.eventId === verdict.eventId);
		const source = state.analysedEvents.get(verdict.eventId);
		const payload = {
			incidentId: incident?.id ?? verdict.eventId,
			eventId: verdict.eventId,
			severity: verdict.severity,
			reason: verdict.reason,
			source: incident?.source ?? source?.source ?? "unknown",
			kind: incident?.kind ?? source?.kind ?? "unknown",
			chain: incident?.chain ?? source?.chain ?? "unknown",
			target: source?.wallet ?? "unknown",
			detail: source?.detail ?? "",
		};

		runLoop(
			agent.getId(),
			`High severity incident: ${JSON.stringify(payload)}`,
			isolatedInput(agent, MODEL_RESPONDER, 320),
			new GuardrailInterceptionHandler(),
		);
	}
}

export const highSeverityHandler: SituationHandler = {
	specification: new HighSeveritySpecification(),
	processor: new RespondProcessor(),
};
