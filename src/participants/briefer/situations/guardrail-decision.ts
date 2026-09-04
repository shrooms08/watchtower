import { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isGuardrailDecisionPayload } from "../../../guardrail-events";
import { resolveRuntime } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";
import { brieferMayRun, runBrief } from "../brief";

export class GuardrailDecidedSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		if (context.event.type !== "guardrail.decision" || !isGuardrailDecisionPayload(context.event.payload)) {
			return false;
		}

		return brieferMayRun("guardrail decision");
	}
}

export class BriefDecisionProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		if (!isGuardrailDecisionPayload(context.event.payload)) {
			return;
		}

		const { pendingId, incidentId, decision, by } = context.event.payload;
		const pending = resolveRuntime().state.getPending(pendingId);
		const detail = pending ? `${pending.action} on ${pending.target}` : "an action";

		runBrief(
			context.participant as Agent,
			`The operator ${decision} (by ${by}) the request to ${detail} for incident ${incidentId}.`,
		);
	}
}

export const guardrailDecidedHandler: SituationHandler = {
	specification: new GuardrailDecidedSpecification(),
	processor: new BriefDecisionProcessor(),
};
