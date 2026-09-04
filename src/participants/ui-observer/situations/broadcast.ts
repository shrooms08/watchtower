import { SemanticEvent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isChainEventPayload } from "../../../chain-event";
import { isCorrelationFoundPayload } from "../../../correlation";
import { isGuardrailDecisionPayload, isGuardrailPendingPayload } from "../../../guardrail-events";
import { resolveParticipant, resolveRuntime } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";
import { nextSeq, publishEnvelope } from "../../../stream";

const MAX_STRING = 2_000;
const MAX_CONTENT = 200;

export class AnyEventSpecification extends SafeSpecification {
	protected evaluate(_context: SituationContext): boolean {
		return true;
	}
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}...[+${value.length - limit}]` : value;
}

/**
 * Depth-limited, cycle-safe, and string-truncating. Anything that is not plain
 * JSON (functions, class instances, ModelContext, sockets) is dropped rather
 * than serialised, so nothing internal can leak to a browser by accident.
 */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return Number.isFinite(value as number) || typeof value !== "number" ? value : null;
	}

	if (typeof value === "string") {
		return truncate(value, MAX_STRING);
	}

	if (typeof value !== "object" || depth > 4) {
		return undefined;
	}

	if (seen.has(value as object)) {
		return undefined;
	}

	seen.add(value as object);

	if (Array.isArray(value)) {
		return value.slice(0, 50).map((entry) => sanitize(entry, depth + 1, seen));
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	const prototype = Object.getPrototypeOf(value);

	// Plain objects only: a class instance is summarised, never walked.
	if (prototype !== Object.prototype && prototype !== null) {
		return `[${(value as object).constructor?.name ?? "object"}]`;
	}

	const out: Record<string, unknown> = {};

	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		const clean = sanitize(entry, depth + 1, seen);

		if (clean !== undefined) {
			out[key] = clean;
		}
	}

	return out;
}

/** Inference and context events carry the whole ModelContext; never forward it. */
function summariseInference(event: SemanticEvent): Record<string, unknown> {
	const payload = event.payload as Record<string, any> | undefined;
	const out: Record<string, unknown> = {};

	if (typeof payload?.model === "string") {
		out.model = payload.model;
	}

	if (typeof payload?.loopId === "string") {
		out.loopId = payload.loopId;
	}

	const usage = payload?.tokenUsage;

	if (usage && typeof usage.totalTokens === "number") {
		out.totalTokens = usage.totalTokens;
	}

	if (typeof payload?.content === "string") {
		out.content = truncate(payload.content, MAX_CONTENT);
	}

	if (Array.isArray(payload?.items)) {
		out.items = payload.items.map((item: any) => (typeof item?.getType === "function" ? item.getType() : "item"));
	}

	return out;
}

function payloadFor(event: SemanticEvent): Record<string, unknown> {
	if (event.type.startsWith("inference.") || event.type.startsWith("context_update.")) {
		return summariseInference(event);
	}

	if (event.type === "model.answer") {
		const answer = (event.payload as { answer?: { content?: { text?: string } } })?.answer;
		const text = answer?.content?.text ?? "";
		const state = resolveRuntime().state;
		// A question answer is claimed by the pending queue before the brief
		// handler sees it, so the marker has to be derived the same way.
		const kind = state.pendingOperatorQuestions.length > 0 ? "operator_answer" : "answer";

		return { kind, text: truncate(text, MAX_STRING) };
	}

	if (event.type === "chain.event" && isChainEventPayload(event.payload)) {
		return { kind: "chain_event", ...(sanitize(event.payload) as Record<string, unknown>) };
	}

	if (event.type === "correlation.found" && isCorrelationFoundPayload(event.payload)) {
		return { kind: "correlation", ...(sanitize(event.payload) as Record<string, unknown>) };
	}

	if (event.type === "guardrail.pending" && isGuardrailPendingPayload(event.payload)) {
		return { kind: "guardrail_pending", ...(sanitize(event.payload) as Record<string, unknown>) };
	}

	if (event.type === "guardrail.decision" && isGuardrailDecisionPayload(event.payload)) {
		return { kind: "guardrail_decision", ...(sanitize(event.payload) as Record<string, unknown>) };
	}

	const clean = sanitize(event.payload);

	return typeof clean === "object" && clean !== null && !Array.isArray(clean)
		? (clean as Record<string, unknown>)
		: { value: clean ?? null };
}

function describeProducer(event: SemanticEvent): { producer: string; producerRole: string } {
	try {
		const manifest = resolveParticipant(event.producerId).getManifest();

		return { producer: manifest.name, producerRole: manifest.role };
	} catch {
		const manifest = event.payload as { name?: string; role?: string } | undefined;

		return { producer: manifest?.name ?? `<${event.producerId.slice(0, 8)}>`, producerRole: manifest?.role ?? "unknown" };
	}
}

export class BroadcastProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const { event } = context;
		const { producer, producerRole } = describeProducer(event);

		publishEnvelope({
			seq: nextSeq(),
			ts: event.occurredAt.toISOString(),
			type: event.type,
			producer,
			producerRole,
			inflight: resolveRuntime().state.inFlight(),
			payload: payloadFor(event),
		});
	}
}

export const broadcastHandler: SituationHandler = {
	specification: new AnyEventSpecification(),
	processor: new BroadcastProcessor(),
};
