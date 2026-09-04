import { parseJson } from "./chain-event";
import type { Incident } from "./runtime";

/** How far back the correlator looks, and how often it is allowed to look. */
export const CORRELATION_WINDOW_MS = 120_000;
export const CORRELATOR_MIN_INTERVAL_MS = 15_000;

export type CorrelationVerdict = {
	linked: boolean;
	incidentIds: string[];
	pattern: string;
	confidence: "low" | "medium" | "high";
};

export type CorrelationFoundPayload = {
	id: string;
	incidentIds: string[];
	pattern: string;
	confidence: "low" | "medium" | "high";
	ts: string;
};

/** Stable key for a set of incidents, so the same set is never re-evaluated. */
export function windowKey(incidents: readonly Incident[]): string {
	return incidents
		.map((incident) => incident.id)
		.slice()
		.sort()
		.join(",");
}

/** Incidents in the window that carry a real source, grouped by that source. */
export function distinctSources(incidents: readonly Incident[]): string[] {
	const sources = new Set<string>();

	for (const incident of incidents) {
		if (incident.source && incident.source !== "unknown") {
			sources.add(incident.source);
		}
	}

	return [...sources];
}

function coerceCorrelation(value: unknown): CorrelationVerdict | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;

	if (typeof candidate.linked !== "boolean") {
		return undefined;
	}

	const confidence = String(candidate.confidence ?? "").toLowerCase();
	const ids = Array.isArray(candidate.incidentIds)
		? candidate.incidentIds.filter((id): id is string => typeof id === "string")
		: [];

	return {
		linked: candidate.linked,
		incidentIds: ids,
		pattern: typeof candidate.pattern === "string" ? candidate.pattern : "",
		confidence: (["low", "medium", "high"].includes(confidence) ? confidence : "low") as CorrelationVerdict["confidence"],
	};
}

export function parseCorrelation(text: string): CorrelationVerdict | undefined {
	return parseJson(text, coerceCorrelation);
}

export function isCorrelationFoundPayload(value: unknown): value is CorrelationFoundPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return (
		typeof candidate.id === "string" &&
		Array.isArray(candidate.incidentIds) &&
		candidate.incidentIds.every((id) => typeof id === "string") &&
		typeof candidate.pattern === "string" &&
		typeof candidate.confidence === "string" &&
		typeof candidate.ts === "string"
	);
}
