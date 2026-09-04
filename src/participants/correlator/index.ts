import { createAgent } from "@mozaik-ai/core";
import { crossStreamHandler } from "./situations/analyst-answer";
import { ownAnswerHandler } from "./situations/own-answer";

export const correlator = createAgent({
	name: "Correlator",
	capabilities: [],
	instruction:
		"You are a cross-chain correlation analyst. Decide whether these incidents from different streams are related: same wallet or wallet prefix, same kind within seconds of each other, or a plausible coordinated sequence. Reply ONLY with JSON: " +
		'{"linked": true|false, "incidentIds": [...], "pattern": "<one sentence>", "confidence": "low"|"medium"|"high"}\n' +
		"Simultaneous failed bursts on two busy programs usually mean network-wide congestion, not a coordinated attack. " +
		"Only report linked=true with a pattern that names the concrete shared element (same wallet, same program, privilege change followed by transfer). " +
		"Confidence high requires a shared wallet or a privilege change plus fund movement; otherwise medium or low. " +
		"Do not use the word attack unless the incidents themselves contain evidence of one.",
	tools: [],
	handlers: [crossStreamHandler, ownAnswerHandler],
});
