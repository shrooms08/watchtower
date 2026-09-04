import { createHuman, SemanticEvent } from "@mozaik-ai/core";
import type { OperatorDecisionPayload } from "../../guardrail-events";
import { resolveRuntime, sendEvent } from "../../runtime";
import type { GuardrailDecision } from "../../runtime";
import { approvalCommandHandler } from "./situations/approval-command";

/** The human in the loop: settles guardrail approvals with /approve or /reject. */
export const operator = createHuman({
	name: "Operator",
	capabilities: ["acknowledge_incident", "approve_actions"],
	handlers: [approvalCommandHandler],
});

/**
 * The one route for an operator decision, used by both the /approve message and
 * the HTTP endpoint. It announces the attribution first, then records the
 * decision the interceptor is polling for, so the operator's own event always
 * precedes the guardrail.decision it causes.
 */
export function recordOperatorDecision(
	pendingId: string,
	decision: "approved" | "rejected",
	note: string,
): { ok: boolean; reason?: string } {
	const state = resolveRuntime().state;
	const pending = state.getPending(pendingId);

	if (!pending) {
		return { ok: false, reason: "unknown pendingId" };
	}

	const payload: OperatorDecisionPayload = {
		pendingId,
		incidentId: pending.incidentId,
		decision,
		ts: new Date().toISOString(),
	};

	sendEvent(SemanticEvent.create("operator.decision", operator.getId(), payload), operator.getId());

	const record: GuardrailDecision = {
		pendingId,
		incidentId: pending.incidentId,
		decision,
		by: "operator",
		ts: payload.ts,
		note,
	};

	return state.resolvePending(record) ? { ok: true } : { ok: false, reason: "already decided" };
}
