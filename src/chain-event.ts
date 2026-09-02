import { randomUUID } from "node:crypto";

export type ChainName = "solana" | "base";
export type EventKind = "large_transfer" | "authority_change" | "failed_burst" | "normal";

export const EVENT_KINDS: readonly EventKind[] = ["large_transfer", "authority_change", "failed_burst", "normal"];

export type ChainEventPayload = {
	eventId: string;
	chain: ChainName;
	/** Which watcher produced this - two live streams share chain "solana". */
	source: string;
	txSig: string;
	kind: EventKind;
	amountUsd: number;
	amountSol?: number;
	wallet: string;
	ts: string;
	detail: string;
};

/** Short correlation id carried into the prompt and echoed back by the model. */
export function newEventId(): string {
	return randomUUID().slice(0, 8);
}

/**
 * sendEvent accepts any payload under any type name, so nothing may read a
 * custom event's fields before this passes (MOZAIK-NOTES.md gotcha 14).
 */
export function isChainEventPayload(value: unknown): value is ChainEventPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.eventId === "string" &&
		candidate.eventId.length > 0 &&
		(candidate.chain === "solana" || candidate.chain === "base") &&
		typeof candidate.source === "string" &&
		candidate.source.length > 0 &&
		typeof candidate.txSig === "string" &&
		typeof candidate.kind === "string" &&
		EVENT_KINDS.includes(candidate.kind as EventKind) &&
		typeof candidate.amountUsd === "number" &&
		(candidate.amountSol === undefined || typeof candidate.amountSol === "number") &&
		typeof candidate.wallet === "string" &&
		typeof candidate.ts === "string" &&
		typeof candidate.detail === "string"
	);
}

export type Verdict = {
	eventId: string;
	severity: "low" | "medium" | "high";
	reason: string;
};

function coerceVerdict(value: unknown): Verdict | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const severity = String(candidate.severity ?? "").toLowerCase();

	if (typeof candidate.eventId !== "string" || !["low", "medium", "high"].includes(severity)) {
		return undefined;
	}

	return {
		eventId: candidate.eventId,
		severity: severity as Verdict["severity"],
		reason: typeof candidate.reason === "string" ? candidate.reason : "",
	};
}

/**
 * Tolerant: Mozaik's structuredOutput cannot be used with Anthropic in
 * 4.0.0-beta.12 (its mapper sends output_config.format.json_schema where the
 * API expects .schema, a hard 400), so the model is asked for JSON in the
 * prompt and the answer may arrive fenced or with prose around it.
 */
export function parseVerdict(text: string): Verdict | undefined {
	const trimmed = text.trim();
	const candidates = [trimmed];

	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced?.[1]) {
		candidates.push(fenced[1].trim());
	}

	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first !== -1 && last > first) {
		candidates.push(trimmed.slice(first, last + 1));
	}

	for (const candidate of candidates) {
		try {
			const verdict = coerceVerdict(JSON.parse(candidate));

			if (verdict) {
				return verdict;
			}
		} catch {
			// try the next candidate
		}
	}

	return undefined;
}
