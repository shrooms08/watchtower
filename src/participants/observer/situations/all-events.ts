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
import type { ChainEventPayload } from "../../watcher";

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

/** inference.* payloads carry no loop id; context_update.* do. */
function loopIdOf(event: SemanticEvent): string {
	const loopId = (event.payload as { loopId?: string } | undefined)?.loopId;

	return loopId ? ` loop=${loopId.slice(0, 8)}` : " loop=n/a";
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
		case "chain.event": {
			// Custom events are only conventionally shaped - never assume the payload.
			const chainEvent = payload as Partial<ChainEventPayload>;

			if (!chainEvent?.chain || !chainEvent.txSig) {
				return `payload=${JSON.stringify(payload)}`;
			}

			return `${chainEvent.chain} ${chainEvent.kind} $${chainEvent.amountUsd} ${chainEvent.txSig.slice(0, 10)}...`;
		}
		case "context_update.started":
			return `${loopIdOf(event)} content=${JSON.stringify(String(payload.content).slice(0, 60))}`;
		case "context_update.completed":
			return `${loopIdOf(event)} model=${payload.model}`;
		case "inference.started":
			return `${loopIdOf(event)} model=${payload.model} streaming=${payload.streaming ?? false}`;
		case "inference.stream":
			return `chunk=${payload?.type ?? "unknown"}`;
		case "inference.completed": {
			const output = payload as InferenceOutput;
			const kinds = output.items.map((item) => item.getType()).join(",");
			return `${loopIdOf(event)} items=[${kinds}] tokens=${output.tokenUsage?.totalTokens ?? "?"}`;
		}
		case "function_call.started": {
			const { call } = payload as { call: FunctionCallItem };
			return `${call.name}(${call.args})`;
		}
		case "function_call.completed":
			return (payload as FunctionCallOutputItem).output.text;
		case "model.answer":
			return JSON.stringify((payload as { answer: ModelMessageItem }).answer.content.text.replace(/\s+/g, " "));
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
		const state = resolveRuntime().state;
		const producer = producerName(event);

		state.eventLog.push({ ts: event.occurredAt.getTime(), type: event.type, producer });

		if (event.type.startsWith("inference.") || event.type === "model.answer") {
			state.lastInferenceActivity = Date.now();
		}

		const custom = (RUNTIME_EVENT_TYPES as readonly string[]).includes(event.type) ? "" : " (custom)";
		const inFlight = state.inFlight();

		console.log(
			`[${event.occurredAt.toISOString()}] [inflight=${inFlight}] ${event.type}${custom} <- ${producer} :: ${describe(event)}`,
		);
	}
}

export const allEventsHandler: SituationHandler = {
	specification: new AnyEventSpecification(),
	processor: new EventLogger(),
};
