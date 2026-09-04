import { Agent, ModelMessageItem, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { resolveRuntime } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";
import { runBrief } from "../brief";

export class OwnAnswerSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return context.event.type === "model.answer" && context.event.producerId === context.participant.getId();
	}
}

export class StoreBriefProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const { answer } = context.event.payload as { answer: ModelMessageItem };
		const state = resolveRuntime().state;
		const text = answer.content.text.trim();

		// A pending question claims this answer: it is a reply to the operator,
		// never the rolling brief, so state.brief is left alone.
		const question = state.pendingOperatorQuestions.shift();

		if (question !== undefined) {
			state.operatorAnswers.push({ question, answer: text, ts: new Date().toISOString() });
			console.log(`[briefer] answered operator: ${text.replace(/\s+/g, " ")}`);
			return;
		}

		if (state.brieferBriefsInFlight > 0) {
			state.brieferBriefsInFlight--;
		}

		state.brief = text;
		console.log(`[briefer] brief updated: ${text.replace(/\s+/g, " ")}`);

		if (!state.brieferDirty) {
			return;
		}

		// One coalesced rerun with the latest state, not a queue: the flag is
		// cleared first, so triggers arriving during this rerun mark it again and
		// earn exactly one more, each one paying for itself out of the budget.
		state.brieferDirty = false;

		if (!state.inferenceBudget.tryConsume()) {
			console.log("[briefer] coalesced rerun skipped - budget exhausted");
			return;
		}

		state.brieferLastRunTs = Date.now();
		console.log("[briefer] coalesced rerun with the latest state");
		runBrief(context.participant as Agent, "Triggers arrived while the last brief was being written.");
	}
}

export const ownAnswerHandler: SituationHandler = {
	specification: new OwnAnswerSpecification(),
	processor: new StoreBriefProcessor(),
};
