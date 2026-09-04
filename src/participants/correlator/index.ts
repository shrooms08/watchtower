import { createAgent } from "@mozaik-ai/core";
import { crossStreamHandler } from "./situations/analyst-answer";
import { ownAnswerHandler } from "./situations/own-answer";

export const correlator = createAgent({
	name: "Correlator",
	capabilities: [],
	instruction:
		"You are a cross-chain correlation analyst. Decide whether these incidents from different streams are related: same wallet or wallet prefix, same kind within seconds of each other, or a plausible coordinated sequence. Reply ONLY with JSON: " +
		'{"linked": true|false, "incidentIds": [...], "pattern": "<one sentence>", "confidence": "low"|"medium"|"high"}',
	tools: [],
	handlers: [crossStreamHandler, ownAnswerHandler],
});
