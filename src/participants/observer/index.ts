import { createHuman } from "@mozaik-ai/core";
import { allEventsHandler } from "./situations/all-events";

export const observer = createHuman({
	name: "Observer",
	capabilities: [],
	handlers: [allEventsHandler],
});
