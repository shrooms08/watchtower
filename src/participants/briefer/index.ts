import { createAgent } from "@mozaik-ai/core";
import { analystAnsweredHandler } from "./situations/analyst-answer";
import { ownAnswerHandler } from "./situations/own-answer";

export const briefer = createAgent({
	name: "Briefer",
	capabilities: [],
	instruction: "You maintain a live ops brief for a crypto protocol operator. Group findings by source stream. Be terse.",
	tools: [],
	handlers: [analystAnsweredHandler, ownAnswerHandler],
});
