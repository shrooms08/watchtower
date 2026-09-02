import { createHuman } from "@mozaik-ai/core";
import { guardrailEventHandler } from "./situations/guardrail-events";

/** Producer of every guardrail.* event, and the participant that logs them. */
export const guardrail = createHuman({
	name: "Guardrail",
	capabilities: ["approve_actions"],
	handlers: [guardrailEventHandler],
});
