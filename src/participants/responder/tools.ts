import { Tool } from "@mozaik-ai/core";
import { GUARDRAIL_ACTIONS } from "../../guardrail-events";
import { resolveRuntime } from "../../runtime";
import type { GuardrailAction } from "../../runtime";

/**
 * SIMULATION ONLY. This tool never touches a chain, signs anything, or calls any
 * network: it appends a record to shared state and returns. Every "executed"
 * status in this project is a simulated response, and reaching it still requires
 * the guardrail to approve the call first.
 */
export const executeAction: Tool = {
	type: "function",
	name: "execute_action",
	description:
		"Request a protective action for a high severity incident. Requires operator approval before it runs. Simulated: no on-chain effect.",
	strict: false,
	parameters: {
		type: "object",
		properties: {
			incidentId: { type: "string", description: "The incident id this action responds to, e.g. INC-001." },
			action: {
				type: "string",
				enum: [...GUARDRAIL_ACTIONS],
				description: "The most proportionate action to take.",
			},
			target: { type: "string", description: "Program id, wallet address, or operator channel the action applies to." },
			reason: { type: "string", description: "One sentence justifying the action." },
		},
		required: ["incidentId", "action", "target", "reason"],
		additionalProperties: false,
	},
	invoke: async ({
		incidentId,
		action,
		target,
		reason,
	}: {
		incidentId: string;
		action: GuardrailAction;
		target: string;
		reason: string;
	}) => {
		const record = {
			incidentId,
			action,
			target,
			reason,
			status: "executed" as const,
			ts: new Date().toISOString(),
		};

		// Simulated execution: recorded in shared state, nothing else happens.
		resolveRuntime().state.recordAction(record);
		console.log(`[responder] execute_action ${action} on ${target} for ${incidentId} (simulated)`);

		return { status: "executed" };
	},
};
