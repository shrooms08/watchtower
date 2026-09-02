import {
	ModelMessageItem,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core";
import { notifyAnswer } from "../../../completion";

export class ModelAnswerSpecification extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return context.event.type === "model.answer";
	}
}

export class ModelAnswerRenderer implements SituationProcessor {
	apply(context: SituationContext): void {
		const { answer } = context.event.payload as { answer: ModelMessageItem };

		console.log(`[${new Date().toISOString()}] [Operator] answer: ${answer.content.text}`);
		notifyAnswer(answer.content.text);
	}
}

export const modelAnswerHandler: SituationHandler = {
	specification: new ModelAnswerSpecification(),
	processor: new ModelAnswerRenderer(),
};
