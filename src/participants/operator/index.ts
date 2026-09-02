import { createHuman } from "@mozaik-ai/core";

/** Placeholder for the human in the loop - joins, reacts to nothing in this run. */
export const operator = createHuman({
	name: "Operator",
	capabilities: ["acknowledge_incident"],
	handlers: [],
});
