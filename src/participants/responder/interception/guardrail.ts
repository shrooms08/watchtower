import {
	FunctionCallItem,
	FunctionCallOutputItem,
	SemanticEvent,
	type ExecutableTransition,
	type InferenceInput,
	type InterceptionHandler,
} from "@mozaik-ai/core";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { GuardrailDecisionPayload, GuardrailPendingPayload } from "../../../guardrail-events";
import { GUARDRAIL_ACTIONS } from "../../../guardrail-events";
import { resolveRuntime, sendEvent } from "../../../runtime";
import type { GuardrailAction, GuardrailDecision } from "../../../runtime";
import { guardrail } from "../../guardrail";

export type GuardrailMode = "auto-reject" | "auto-approve" | "prompt";

export function guardrailMode(): GuardrailMode {
	const mode = process.env.GUARDRAIL_MODE;

	return mode === "auto-approve" || mode === "prompt" ? mode : "auto-reject";
}

const AUTO_REJECT_DELAY_MS = 3_000;
const AUTO_APPROVE_DELAY_MS = 1_000;
const PROMPT_POLL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type CallArgs = {
	incidentId: string;
	action: GuardrailAction;
	target: string;
	reason: string;
};

function readArgs(call: FunctionCallItem): CallArgs {
	const raw = typeof call.args === "string" ? JSON.parse(call.args) : call.args;
	const parsed = (raw ?? {}) as Record<string, unknown>;
	const action = String(parsed.action ?? "");

	return {
		incidentId: String(parsed.incidentId ?? "unknown"),
		action: (GUARDRAIL_ACTIONS.includes(action as GuardrailAction) ? action : "alert_operator") as GuardrailAction,
		target: String(parsed.target ?? "unknown"),
		reason: String(parsed.reason ?? ""),
	};
}

/**
 * Every execute_action call is held here until a decision arrives. Nothing
 * downstream runs on its own: approval returns the transition untouched,
 * rejection rewrites the loop back to inference with a refusal in context.
 */
export class GuardrailInterceptionHandler implements InterceptionHandler {
	isSatisfiedBy(transition: ExecutableTransition): boolean {
		try {
			if (transition.nextStateId !== "function_call") {
				return false;
			}

			const { call } = transition.input as { call: FunctionCallItem };

			return call.name === "execute_action";
		} catch {
			return false;
		}
	}

	async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
		const { call, inferenceInput } = transition.input as {
			call: FunctionCallItem;
			inferenceInput: InferenceInput;
		};

		try {
			const args = readArgs(call);
			const pendingId = `PA-${randomUUID().slice(0, 8)}`;
			const state = resolveRuntime().state;

			const pending: GuardrailPendingPayload = {
				pendingId,
				incidentId: args.incidentId,
				action: args.action,
				target: args.target,
				reason: args.reason,
				ts: new Date().toISOString(),
			};

			state.addPending(pending);
			sendEvent(SemanticEvent.create("guardrail.pending", guardrail.getId(), pending), guardrail.getId());

			const decision = await this.awaitDecision(pendingId, args.incidentId);

			state.resolvePending(decision);

			const announced: GuardrailDecisionPayload = {
				pendingId: decision.pendingId,
				incidentId: decision.incidentId,
				decision: decision.decision,
				by: decision.by,
				ts: decision.ts,
			};

			sendEvent(SemanticEvent.create("guardrail.decision", guardrail.getId(), announced), guardrail.getId());

			if (decision.decision === "approved") {
				// Untouched: the loop proceeds into function_call and the tool runs.
				return transition;
			}

			return this.refuse(call, inferenceInput, decision.note ?? "not approved");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			console.error(`[guardrail] handler error, rejecting by default: ${message}`);

			return this.refuse(call, inferenceInput, `guardrail error: ${message}`);
		}
	}

	/** Rejection path: the model sees its own call plus a refusal, then answers. */
	private refuse(call: FunctionCallItem, inferenceInput: InferenceInput, reason: string): ExecutableTransition {
		const output = FunctionCallOutputItem.create(
			call.callId,
			`Rejected by operator: ${reason}. Do not retry. Acknowledge and stop.`,
		);

		inferenceInput.context.addContextItems([call, output]);

		return { nextStateId: "inference", input: inferenceInput };
	}

	private async awaitDecision(pendingId: string, incidentId: string): Promise<GuardrailDecision> {
		const mode = guardrailMode();
		const auto = (decision: "approved" | "rejected", note: string): GuardrailDecision => ({
			pendingId,
			incidentId,
			decision,
			by: "auto",
			ts: new Date().toISOString(),
			note,
		});

		if (mode === "auto-approve") {
			await sleep(AUTO_APPROVE_DELAY_MS);
			return auto("approved", "GUARDRAIL_MODE=auto-approve");
		}

		if (mode === "auto-reject") {
			await sleep(AUTO_REJECT_DELAY_MS);
			return auto("rejected", "GUARDRAIL_MODE=auto-reject, no operator approval");
		}

		return this.promptForDecision(pendingId, incidentId);
	}

	/**
	 * Blocks on stdin like the human-in-the-loop example, but also watches shared
	 * state so an /approve or /reject message (or a future UI) can settle it.
	 */
	private async promptForDecision(pendingId: string, incidentId: string): Promise<GuardrailDecision> {
		const state = resolveRuntime().state;
		let settled = false;

		const fromState = (async (): Promise<GuardrailDecision> => {
			while (!settled) {
				const recorded = state.decisionFor(pendingId);

				if (recorded) {
					return recorded;
				}

				await sleep(PROMPT_POLL_MS);
			}

			throw new Error("unreachable");
		})();

		const rl = createInterface({ input: process.stdin, output: process.stdout });

		const fromStdin = (async (): Promise<GuardrailDecision> => {
			while (true) {
				const answer = (await rl.question(`Approve ${pendingId} (${incidentId})? [y/n] `)).trim().toLowerCase();

				if (answer === "y" || answer === "yes" || answer === "n" || answer === "no") {
					return {
						pendingId,
						incidentId,
						decision: answer.startsWith("y") ? "approved" : "rejected",
						by: "operator",
						ts: new Date().toISOString(),
						note: "decided at the prompt",
					};
				}

				console.log("Please enter y or n.");
			}
		})();

		try {
			return await Promise.race([fromStdin, fromState]);
		} finally {
			settled = true;
			rl.close();
		}
	}
}
