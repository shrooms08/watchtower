import { SituationContext, SituationHandler } from "@mozaik-ai/core";
import { resolveRuntime } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";

const APPROVE = /^\/approve (\S+)/;
const REJECT = /^\/reject (\S+)/;

function commandOf(context: SituationContext): { decision: "approved" | "rejected"; pendingId: string } | undefined {
	const { message } = context.event.payload as { message?: unknown };

	if (typeof message !== "string") {
		return undefined;
	}

	const approve = APPROVE.exec(message.trim());

	if (approve?.[1]) {
		return { decision: "approved", pendingId: approve[1] };
	}

	const reject = REJECT.exec(message.trim());

	if (reject?.[1]) {
		return { decision: "rejected", pendingId: reject[1] };
	}

	return undefined;
}

/** Only the Operator's own /approve and /reject messages. */
export class ApprovalCommandSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		return (
			context.event.type === "message.sent" &&
			context.event.producerId === context.participant.getId() &&
			commandOf(context) !== undefined
		);
	}
}

export class ApprovalCommandProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const command = commandOf(context);

		if (!command) {
			return;
		}

		const state = resolveRuntime().state;
		const pending = state.getPending(command.pendingId);

		if (!pending) {
			console.warn(`[operator] no pending approval ${command.pendingId}`);
			return;
		}

		// The interceptor polls shared state, so recording here settles its wait.
		const recorded = state.resolvePending({
			pendingId: pending.pendingId,
			incidentId: pending.incidentId,
			decision: command.decision,
			by: "operator",
			ts: new Date().toISOString(),
			note: `operator /${command.decision === "approved" ? "approve" : "reject"}`,
		});

		if (!recorded) {
			console.warn(`[operator] ${command.pendingId} was already decided`);
			return;
		}

		console.log(`[operator] ${command.decision === "approved" ? "approved" : "rejected"} ${command.pendingId}`);
	}
}

export const approvalCommandHandler: SituationHandler = {
	specification: new ApprovalCommandSpecification(),
	processor: new ApprovalCommandProcessor(),
};
