import {
	Agent,
	InferenceInput,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core";
import { runLoop } from "../../../runtime";

export const MODEL = "claude-haiku-4-5";

export class MessageSentSpecification extends SituationSpecification {
	isSatisfiedBy(context: SituationContext): boolean {
		return context.event.type === "message.sent";
	}
}

export class InferenceProcessor implements SituationProcessor {
	apply(context: SituationContext): void {
		const agent = context.participant as Agent;
		const { message } = context.event.payload as { message: string };

		const inferenceInput: InferenceInput = {
			model: MODEL,
			maxOutputTokens: 256,
			context: agent.getMemory().getContext(),
			tools: agent.getTools(),
		};

		runLoop(agent.getId(), message, inferenceInput);
	}
}

export const messageSentHandler: SituationHandler = {
	specification: new MessageSentSpecification(),
	processor: new InferenceProcessor(),
};
