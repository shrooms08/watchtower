import { SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isGuardrailDecisionPayload, isGuardrailPendingPayload } from "../../../guardrail-events";
import { SafeProcessor, SafeSpecification } from "../../../safe";

export class GuardrailEventSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return context.event.type === "guardrail.pending" || context.event.type === "guardrail.decision";
	}
}

export class GuardrailEventLogger extends SafeProcessor {
	protected run(context: SituationContext): void {
		const { event } = context;

		if (event.type === "guardrail.pending" && isGuardrailPendingPayload(event.payload)) {
			const { pendingId, incidentId, action, target } = event.payload;
			console.log(`[guardrail] PENDING ${pendingId} incident=${incidentId} action=${action} target=${target}`);
			return;
		}

		if (event.type === "guardrail.decision" && isGuardrailDecisionPayload(event.payload)) {
			const { pendingId, decision, by } = event.payload;
			console.log(`[guardrail] DECISION ${pendingId} ${decision.toUpperCase()} by ${by}`);
			return;
		}

		console.warn(`[guardrail] ignored ${event.type} with unknown payload shape`);
	}
}

export const guardrailEventHandler: SituationHandler = {
	specification: new GuardrailEventSpecification(),
	processor: new GuardrailEventLogger(),
};
