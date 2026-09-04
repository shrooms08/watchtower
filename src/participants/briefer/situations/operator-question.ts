import { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isolatedInput } from "../../../agent-context";
import { MODEL_BRIEFER } from "../../../models";
import { resolveRuntime, runLoop } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";
import { operator } from "../../operator";

function questionOf(context: SituationContext): string | undefined {
	const { message } = context.event.payload as { message?: unknown };

	if (typeof message !== "string") {
		return undefined;
	}

	const text = message.trim();

	// "/approve" and friends belong to the Operator's own command handler.
	return text.length > 0 && !text.startsWith("/") ? text : undefined;
}

/**
 * A question is not a brief rewrite, so it deliberately skips the 8s coalescing
 * gate: the operator is waiting for this one.
 */
export class OperatorQuestionSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		if (context.event.type !== "message.sent" || context.event.producerId !== operator.getId()) {
			return false;
		}

		if (questionOf(context) === undefined) {
			return false;
		}

		const budget = resolveRuntime().state.inferenceBudget;

		if (!budget.tryConsume()) {
			console.log(`[briefer] budget exhausted (${budget.used}/${budget.max}) - question not answered`);
			return false;
		}

		return true;
	}
}

export class AnswerQuestionProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const agent = context.participant as Agent;
		const question = questionOf(context);

		if (question === undefined) {
			return;
		}

		const state = resolveRuntime().state;

		// model.answer carries no loop id, so a pending-question queue is the only
		// way to recognise the reply. Answers are unambiguous while no brief is in
		// flight, which is the common case; overlap is logged, not hidden.
		if (state.brieferBriefsInFlight > 0) {
			console.warn(
				`[briefer] question dispatched while ${state.brieferBriefsInFlight} brief loop(s) in flight - answer matching falls back to dispatch order`,
			);
		}

		state.pendingOperatorQuestions.push(question);

		const snapshot = {
			incidents: state.incidents.map(({ id, source, kind, severity, summary }) => ({
				id,
				source,
				kind,
				severity,
				reason: summary,
			})),
			correlations: state.correlations,
			brief: state.brief,
			decisions: state.decisions,
			watcherStats: state.watcherStats(),
		};

		console.log(`[briefer] operator asked: ${question}`);

		runLoop(
			agent.getId(),
			`Operator asks: ${question}\n\nCurrent state: ${JSON.stringify(snapshot)}\n\n` +
				"Use only facts present in the state. Do not infer outcomes, success, or failure that the state does not record. " +
				"If unsure, say the state does not show it.",
			isolatedInput(agent, MODEL_BRIEFER, 220),
		);
	}
}

export const operatorQuestionHandler: SituationHandler = {
	specification: new OperatorQuestionSpecification(),
	processor: new AnswerQuestionProcessor(),
};
