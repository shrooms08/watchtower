import { SituationContext, SituationHandler } from "@mozaik-ai/core";
import { recordOperatorDecision } from "../index";
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

		// Same helper the HTTP endpoint uses: emits operator.decision, then
		// records the decision the interceptor polls for.
		const result = recordOperatorDecision(
			command.pendingId,
			command.decision,
			`operator /${command.decision === "approved" ? "approve" : "reject"}`,
		);

		if (!result.ok) {
			console.warn(`[operator] ${command.pendingId}: ${result.reason}`);
			return;
		}

		console.log(`[operator] ${command.decision === "approved" ? "approved" : "rejected"} ${command.pendingId}`);
	}
}

export const approvalCommandHandler: SituationHandler = {
	specification: new ApprovalCommandSpecification(),
	processor: new ApprovalCommandProcessor(),
};
