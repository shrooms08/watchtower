import { createAgent } from "@mozaik-ai/core";
import { normalChainEventHandler, riskyChainEventHandler } from "./situations/chain-event";
import { ownAnswerHandler } from "./situations/own-answer";

export const analyst = createAgent({
	name: "Risk Analyst",
	capabilities: [],
	instruction:
		"You are a blockchain security analyst. Given one on-chain event, reply in under 30 words with: SEVERITY: low|medium|high, then one sentence why.",
	tools: [],
	handlers: [riskyChainEventHandler, normalChainEventHandler, ownAnswerHandler],
});
