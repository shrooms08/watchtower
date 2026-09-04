import { createHuman } from "@mozaik-ai/core";
import { broadcastHandler } from "./situations/broadcast";

/** Turns every runtime event into a sanitized envelope for connected browsers. */
export const uiObserver = createHuman({
	name: "UI Observer",
	capabilities: [],
	handlers: [broadcastHandler],
});
