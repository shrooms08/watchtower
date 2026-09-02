import {
	ModelMessageItem,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core";
import { resolveRuntime } from "../../../runtime";

export class OwnAnswerSpecification extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return context.event.type === "model.answer" && context.event.producerId === context.participant.getId();
	}
}

export class StoreBriefProcessor implements SituationProcessor {
	apply(context: SituationContext): void {
		const { answer } = context.event.payload as { answer: ModelMessageItem };
		const brief = answer.content.text.trim();

		resolveRuntime().state.brief = brief;
		console.log(`[briefer] brief updated: ${brief.replace(/\s+/g, " ")}`);
	}
}

export const ownAnswerHandler: SituationHandler = {
	specification: new OwnAnswerSpecification(),
	processor: new StoreBriefProcessor(),
};
