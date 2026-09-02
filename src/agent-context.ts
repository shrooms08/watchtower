import { Agent, DeveloperMessageItem, InferenceInput, ModelContext } from "@mozaik-ai/core";

/**
 * A private context per runLoop.
 *
 * `agent.getMemory().getContext()` (what the examples pass) is a single mutable
 * ModelContext - `addContextItems` pushes into it and returns `this`. Two loops
 * running at once on the same agent would therefore append into the same array
 * and each inference would see the other's prompt. Concurrency is the whole
 * point here, so every loop gets a fresh context seeded with the agent's
 * instruction instead.
 */
export function isolatedInput(agent: Agent, model: string, maxOutputTokens: number): InferenceInput {
	const context = ModelContext.create();
	context.addItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));

	return {
		model,
		maxOutputTokens,
		context,
		tools: agent.getTools(),
	};
}
