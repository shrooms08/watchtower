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
		const brief = answer.content.text.trim();

		state.brief = brief;
		console.log(`[briefer] brief updated: ${brief.replace(/\s+/g, " ")}`);

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
