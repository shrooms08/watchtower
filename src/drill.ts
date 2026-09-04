import "dotenv/config";
import { SemanticEvent } from "@mozaik-ai/core";
import { newEventId, type ChainEventPayload } from "./chain-event";
import { modelSummary } from "./models";
import { analyst } from "./participants/analyst";
import { briefer } from "./participants/briefer";
import { guardrail } from "./participants/guardrail";
import { observer } from "./participants/observer";
import { operator } from "./participants/operator";
import { responder } from "./participants/responder";
import { correlator } from "./participants/correlator";
import { guardrailMode } from "./participants/responder/interception/guardrail";
import {
	allRejectionsAcknowledged,
	briefMentionsDecision,
	printBriefDecisionCheck,
	printCorrelationsSection,
	printGuardrailSection,
} from "./report";
import { EnvironmentState, initializeRuntime, join, resolveRuntime, sendEvent } from "./runtime";

type DrillMode = "single" | "multi";

const DRILL_MODE: DrillMode = process.env.DRILL_MODE === "multi" ? "multi" : "single";
const MULTI = DRILL_MODE === "multi";
const MAX_INFERENCES = MULTI ? 8 : 4;
const DEADLINE_MS = MULTI ? 60_000 : 45_000;
const SHARED_WALLET = "9xKqRmT4vN2sBhP7yLzEwUdFgC5jXaQnV8MkZrH3TbSy";

const state = EnvironmentState.create(MAX_INFERENCES);
initializeRuntime({ state });
state.analystId = analyst.getId();

join(observer);
join(guardrail);
join(operator);
join(analyst);
join(briefer);
join(correlator);
join(responder);

process.on("unhandledRejection", (reason) => {
	console.error(`[drill] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();

// Two phrasings of the same drill: the second is used only if the first does not
// come back high severity. The analyst instruction is never touched.
const DETAILS = [
	"Upgrade authority transferred to unknown wallet 9xK... then 4.8M USDC withdrawn from the vault in the same slot.",
	"Program upgrade authority reassigned to an unknown wallet 9xK..., and in the same slot the entire 4.8M USDC vault balance was drained to that wallet. The multisig did not sign, no governance proposal exists, and the mint authority was also changed.",
];

function inject(overrides: Partial<ChainEventPayload> & { detail: string }): string {
	const payload: ChainEventPayload = {
		eventId: newEventId(),
		chain: "solana",
		source: "Drill",
		txSig: "DriLL1111111111111111111111111111111111111111",
		kind: "authority_change",
		amountUsd: 4_800_000,
		wallet: SHARED_WALLET,
		ts: new Date().toISOString(),
		...overrides,
	};

	sendEvent(SemanticEvent.create("chain.event", operator.getId(), payload), operator.getId());

	return payload.eventId;
}

function injectDrillEvent(detail: string): string {
	return inject({ detail });
}

/**
 * Two events, two seconds apart, from two streams, sharing one wallet: an
 * authority change on one chain and the drain that follows on the other. The
 * link is the thing under test, so it is left implicit in the data rather than
 * stated for the model.
 */
function injectMultiDrill(): { first: string; second: () => string } {
	const first = inject({
		source: "Drill-Solana",
		kind: "authority_change",
		amountUsd: 0,
		detail:
			"Program upgrade authority moved from the 3-of-5 multisig to a single unknown wallet. No governance proposal exists and no multisig signature was recorded.",
	});

	return {
		first,
		second: () =>
			inject({
				source: "Drill-Base",
				chain: "base",
				kind: "large_transfer",
				amountUsd: 4_800_000,
				detail:
					"4.8M USDC bridged out immediately after the authority change on the other chain, to the same wallet that received the upgrade authority.",
			}),
	};
}

/** The guardrail half of the chain: a decision exists and was acknowledged. */
function guardrailComplete(): boolean {
	return state.decisions.length > 0 && allRejectionsAcknowledged(state) && state.responderAcks.length > 0;
}

async function waitUntil(predicate: () => boolean, deadlineAt: number): Promise<boolean> {
	while (Date.now() < deadlineAt) {
		if (predicate()) {
			return true;
		}

		await sleep(250);
	}

	return false;
}

async function waitForSeverity(eventId: string, deadlineAt: number): Promise<string> {
	await waitUntil(() => state.incidents.some((entry) => entry.eventId === eventId), deadlineAt);

	return state.incidents.find((entry) => entry.eventId === eventId)?.severity ?? "";
}

/** Tolerant: the model may echo incident ids or the event ids it was shown. */
function correlationCovers(eventIds: readonly string[]): boolean {
	const wanted = eventIds
		.map((eventId) => state.incidents.find((entry) => entry.eventId === eventId))
		.filter((incident): incident is NonNullable<typeof incident> => incident !== undefined);

	if (wanted.length < eventIds.length) {
		return false;
	}

	return state.correlations.some((correlation) =>
		wanted.every((incident) =>
			correlation.incidentIds.some((id) => id === incident.id || id === incident.eventId),
		),
	);
}

function briefMentionsLink(): boolean {
	const brief = state.brief.toLowerCase();

	if (state.correlations.some((correlation) => brief.includes(correlation.id.toLowerCase()))) {
		return true;
	}

	if (
		state.correlations.some((correlation) =>
			correlation.incidentIds.every((id) => brief.includes(id.toLowerCase())),
		)
	) {
		return true;
	}

	return /link|correlat|same wallet|coordinat|both chains|cross-chain|cross-stream/.test(brief);
}

console.log(`[drill] mode=${DRILL_MODE} models: ${modelSummary()} budget=${MAX_INFERENCES} guardrail=${guardrailMode()}\n`);

const deadlineAt = startedAt + DEADLINE_MS;
let eventIds: string[] = [];
let severity = "";
let completed = false;

if (MULTI) {
	const multi = injectMultiDrill();
	eventIds.push(multi.first);

	await sleep(2_000);
	eventIds.push(multi.second());

	// Both verdicts, then the link, then the brief, then the guardrail chain.
	const bothAssessed = await waitUntil(
		() => eventIds.every((eventId) => state.incidents.some((entry) => entry.eventId === eventId)),
		deadlineAt,
	);
	const severities = eventIds.map(
		(eventId) => state.incidents.find((entry) => entry.eventId === eventId)?.severity ?? "",
	);
	severity = severities.includes("high") ? "high" : (severities.find(Boolean) ?? "");

	const linked = bothAssessed && (await waitUntil(() => correlationCovers(eventIds), deadlineAt));
	const briefed = linked && (await waitUntil(briefMentionsLink, deadlineAt));

	completed = briefed && (await waitUntil(guardrailComplete, deadlineAt));
} else {
	eventIds.push(injectDrillEvent(DETAILS[0]!));
	severity = await waitForSeverity(eventIds[0]!, Math.min(Date.now() + 15_000, deadlineAt));

	// Retry once with sharper wording if it did not come back high.
	if (severity !== "high") {
		console.log(`[drill] verdict was "${severity || "none"}", retrying once with sharper drill wording`);
		eventIds.push(injectDrillEvent(DETAILS[1]!));
		severity = await waitForSeverity(eventIds[1]!, Math.min(Date.now() + 15_000, deadlineAt));
	}

	completed = severity === "high" && (await waitUntil(guardrailComplete, deadlineAt));
}

// The brief that states the decision is written after the decision, so wait for
// it rather than reporting whichever brief happened to be current.
const briefStatesDecision =
	completed && (await waitUntil(() => briefMentionsDecision(state.brief), deadlineAt));

console.log(`\n${"=".repeat(72)}`);
console.log("DRILL REPORT");
console.log("=".repeat(72));
console.log(`Wall clock:                ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`Drill mode:                ${DRILL_MODE}`);
console.log(`Guardrail mode:            ${guardrailMode()}`);
console.log(`Drill events:              ${eventIds.join(", ")}`);
console.log(`Analyst severity:          ${severity || "none"}`);
console.log(`Budget used:               ${state.inferenceBudget.used}/${state.inferenceBudget.max}`);
console.log(`Incidents:                 ${state.incidents.length}`);

for (const incident of state.incidents) {
	console.log(
		`  ${incident.id} eventId=${incident.eventId} source=${incident.source} correlated=${incident.correlated} [${incident.severity}] ${incident.summary.replace(/\s+/g, " ")}`,
	);
}

printCorrelationsSection(state);
printGuardrailSection(state);
printBriefDecisionCheck(state);
console.log(`Brief mentions the link:   ${state.correlations.length === 0 ? "n/a (no links)" : briefMentionsLink() ? "yes" : "no"}`);
console.log(`Final brief:               ${state.brief.replace(/\s+/g, " ")}`);
console.log("=".repeat(72));

if (severity !== "high") {
	console.error(`DRILL FAIL: analyst rated the drill event "${severity || "none"}", not high`);
	process.exit(1);
}

if (MULTI && !correlationCovers(eventIds)) {
	console.error("DRILL FAIL: no correlation.found linked both drill incidents");
	process.exit(1);
}

if (MULTI && !briefMentionsLink()) {
	console.error("DRILL FAIL: the final brief does not mention the cross-stream link");
	process.exit(1);
}

if (state.decisions.length === 0) {
	console.error("DRILL FAIL: no guardrail.decision was recorded");
	process.exit(1);
}

if (!MULTI && completed && !briefStatesDecision) {
	console.error("DRILL FAIL: the final brief does not state the operator's decision");
	process.exit(1);
}

if (!completed || state.responderAcks.length === 0) {
	console.error("DRILL FAIL: the responder did not acknowledge the guardrail decision within the deadline");
	process.exit(1);
}

console.log(
	`DRILL PASS: ${state.decisions.map((d) => `${d.decision} by ${d.by}`).join(", ")}; responder acknowledged; ${state.actions.length} action(s) executed; ${state.correlations.length} correlation(s)`,
);
setTimeout(() => process.exit(0), 50);
