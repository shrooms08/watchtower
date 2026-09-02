import {
	FunctionCallItem,
	FunctionCallOutputItem,
	InferenceOutput,
	ModelMessageItem,
	SemanticEvent,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core";
import { resolveParticipant, resolveRuntime } from "../../../runtime";

/** 4.x does not export ParticipantManifest, so mirror the shape we read. */
type ParticipantManifest = {
	readonly id: string;
	readonly name: string;
	readonly role: "agent" | "human";
	readonly capabilities?: readonly string[];
};

/**
 * Every event type the 4.0.0-beta.12 runtime publishes, from
 * node_modules/@mozaik-ai/core/dist/index.mjs (EventPublisherLoopVisitor +
 * ParticipantJoinedEvent / ParticipantLeftEvent / MessageSentEvent).
 */
export const RUNTIME_EVENT_TYPES = [
	"participant.joined",
	"participant.left",
	"message.sent",
	"context_update.started",
	"context_update.completed",
	"inference.started",
	"inference.stream",
	"inference.completed",
	"function_call.started",
	"function_call.completed",
	"model.answer",
	"interception.started",
	"interception.finished",
] as const;

/** Catch-all: matches every event, including custom ones sent with sendEvent. */
export class AnyEventSpecification extends SituationSpecification {
	isSatisfiedBy(_context: SituationContext): boolean {
		return true;
	}
}

/** resolveParticipant throws for unknown ids - participant.left removes before publishing. */
function producerName(event: SemanticEvent): string {
	try {
		return resolveParticipant(event.producerId).getManifest().name;
	} catch {
		const manifest = event.payload as Partial<ParticipantManifest>;
		return manifest?.name ?? `<unresolved ${event.producerId}>`;
	}
}

function describe(event: SemanticEvent): string {
	const payload = event.payload as any;

	switch (event.type) {
		case "participant.joined":
		case "participant.left": {
			const manifest = payload as ParticipantManifest;
			return `${manifest.name} (${manifest.role})`;
		}
		case "message.sent":
			return JSON.stringify((payload as { message: string }).message);
		case "context_update.started":
			return `loop=${payload.loopId} content=${JSON.stringify(payload.content)}`;
		case "context_update.completed":
			return `loop=${payload.loopId} model=${payload.model} items=${payload.context?.getItems?.().length ?? "?"}`;
		case "inference.started":
			return `model=${payload.model} streaming=${payload.streaming ?? false}`;
		case "inference.stream":
			return `chunk=${payload?.type ?? "unknown"}`;
		case "inference.completed": {
			const output = payload as InferenceOutput;
			const kinds = output.items.map((item) => item.getType()).join(",");
			return `items=[${kinds}] tokens=${output.tokenUsage?.totalTokens ?? "?"}`;
		}
		case "function_call.started": {
			const { call } = payload as { call: FunctionCallItem };
			return `${call.name}(${call.args})`;
		}
		case "function_call.completed":
			return (payload as FunctionCallOutputItem).output.text;
		case "model.answer":
			return JSON.stringify((payload as { answer: ModelMessageItem }).answer.content.text);
		case "interception.started":
		case "interception.finished":
			return `next=${payload?.nextStateId ?? "?"}`;
		default:
			return `custom payload=${JSON.stringify(payload)}`;
	}
}

export class EventLogger implements SituationProcessor {
	apply(context: SituationContext): void {
		const { event } = context;
		const seq = resolveRuntime().state.events.record(event.type);
		const known = (RUNTIME_EVENT_TYPES as readonly string[]).includes(event.type) ? "" : " (custom)";

		console.log(
			`[${event.occurredAt.toISOString()}] #${seq} ${event.type}${known} <- ${producerName(event)} :: ${describe(event)}`,
		);
	}
}

export const allEventsHandler: SituationHandler = {
	specification: new AnyEventSpecification(),
	processor: new EventLogger(),
};
