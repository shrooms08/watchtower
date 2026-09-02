import { createHuman } from "@mozaik-ai/core";
import { approvalCommandHandler } from "./situations/approval-command";

/** The human in the loop: settles guardrail approvals with /approve or /reject. */
export const operator = createHuman({
	name: "Operator",
	capabilities: ["acknowledge_incident", "approve_actions"],
	handlers: [approvalCommandHandler],
});
