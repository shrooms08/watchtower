import { createAgent } from "@mozaik-ai/core";
import {
	malformedChainEventHandler,
	normalChainEventHandler,
	riskyChainEventHandler,
} from "./situations/chain-event";
import { ownAnswerHandler } from "./situations/own-answer";

export const analyst = createAgent({
	name: "Risk Analyst",
	capabilities: [],
	instruction:
		"You are a blockchain security analyst. Each event names the source stream it came from; your reason must say which one. " +
		"Reply ONLY with a single JSON object and no other text, no markdown fence: " +
		'{"eventId": "<the eventId you were given>", "severity": "low"|"medium"|"high", "reason": "<one sentence, under 30 words>"}',
	tools: [],
	handlers: [riskyChainEventHandler, normalChainEventHandler, malformedChainEventHandler, ownAnswerHandler],
});
