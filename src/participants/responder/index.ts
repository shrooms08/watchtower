import { createAgent } from "@mozaik-ai/core";
import { highSeverityHandler } from "./situations/high-severity";
import { ownAnswerHandler } from "./situations/own-answer";
import { executeAction } from "./tools";

export const responder = createAgent({
	name: "Responder",
	capabilities: ["request_actions"],
	instruction:
		"You are an incident responder for a crypto protocol. For every high severity incident you MUST call execute_action exactly once with the most proportionate action, then reply with one sentence stating what you requested and its outcome.",
	tools: [executeAction],
	handlers: [highSeverityHandler, ownAnswerHandler],
});
