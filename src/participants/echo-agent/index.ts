import { createAgent } from "@mozaik-ai/core";
import { messageSentHandler } from "./situations/message-sent";

export const echoAgent = createAgent({
	name: "Echo",
	capabilities: [],
	instruction: "Reply with exactly what you are told to reply with.",
	tools: [],
	handlers: [messageSentHandler],
});
