import { createHuman } from "@mozaik-ai/core";
import { modelAnswerHandler } from "./situations/model-answer";

export const user = createHuman({
	name: "Operator",
	capabilities: [],
	handlers: [modelAnswerHandler],
});
