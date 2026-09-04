import type { GuardrailAction } from "./runtime";

export const GUARDRAIL_ACTIONS: readonly GuardrailAction[] = ["pause_program", "freeze_wallet", "alert_operator"];

export type GuardrailPendingPayload = {
	pendingId: string;
	incidentId: string;
	action: GuardrailAction;
	target: string;
	reason: string;
	ts: string;
};

export type GuardrailDecisionPayload = {
	pendingId: string;
	incidentId: string;
	decision: "approved" | "rejected";
	by: "operator" | "auto";
	ts: string;
};

export type OperatorDecisionPayload = {
	pendingId: string;
	incidentId: string;
	decision: "approved" | "rejected";
	ts: string;
};

export function isOperatorDecisionPayload(value: unknown): value is OperatorDecisionPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.pendingId === "string" &&
		typeof candidate.incidentId === "string" &&
		(candidate.decision === "approved" || candidate.decision === "rejected") &&
		typeof candidate.ts === "string"
	);
}

export function isGuardrailPendingPayload(value: unknown): value is GuardrailPendingPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.pendingId === "string" &&
		typeof candidate.incidentId === "string" &&
		typeof candidate.action === "string" &&
		GUARDRAIL_ACTIONS.includes(candidate.action as GuardrailAction) &&
		typeof candidate.target === "string" &&
		typeof candidate.reason === "string" &&
		typeof candidate.ts === "string"
	);
}

export function isGuardrailDecisionPayload(value: unknown): value is GuardrailDecisionPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.pendingId === "string" &&
		typeof candidate.incidentId === "string" &&
		(candidate.decision === "approved" || candidate.decision === "rejected") &&
		(candidate.by === "operator" || candidate.by === "auto") &&
		typeof candidate.ts === "string"
	);
}
