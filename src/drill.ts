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
import { guardrailMode } from "./participants/responder/interception/guardrail";
import { allRejectionsAcknowledged, printGuardrailSection } from "./report";
import { EnvironmentState, initializeRuntime, join, resolveRuntime, sendEvent } from "./runtime";

const MAX_INFERENCES = 4;
const DEADLINE_MS = 45_000;

const state = EnvironmentState.create(MAX_INFERENCES);
initializeRuntime({ state });
state.analystId = analyst.getId();

join(observer);
join(guardrail);
join(operator);
join(analyst);
join(briefer);
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

function injectDrillEvent(detail: string): string {
	const payload: ChainEventPayload = {
		eventId: newEventId(),
		chain: "solana",
		source: "Drill",
		txSig: "DriLL1111111111111111111111111111111111111111",
		kind: "authority_change",
		amountUsd: 4_800_000,
		wallet: "9xKqRmT4vN2sBhP7yLzEwUdFgC5jXaQnV8MkZrH3TbSy",
		ts: new Date().toISOString(),
		detail,
	};

	sendEvent(SemanticEvent.create("chain.event", operator.getId(), payload), operator.getId());

	return payload.eventId;
}

async function waitForChain(eventId: string, deadlineAt: number): Promise<boolean> {
	while (Date.now() < deadlineAt) {
		const incident = state.incidents.find((entry) => entry.eventId === eventId);

		// The full chain: verdict -> responder loop -> guardrail decision -> ack.
		if (incident && state.decisions.length > 0 && allRejectionsAcknowledged(state) && state.responderAcks.length > 0) {
			return true;
		}

		await sleep(250);
	}

	return false;
}

console.log(`[drill] models: ${modelSummary()} budget=${MAX_INFERENCES} guardrail=${guardrailMode()}\n`);

let eventId = injectDrillEvent(DETAILS[0]!);
let severity = "";

// Give the analyst a chance to rate it; retry once with sharper wording if not high.
for (let attempt = 0; attempt < 2; attempt++) {
	const verdictBy = Date.now() + 15_000;

	while (Date.now() < verdictBy) {
		const incident = state.incidents.find((entry) => entry.eventId === eventId);

		if (incident) {
			severity = incident.severity;
			break;
		}

		await sleep(250);
	}

	if (severity === "high" || attempt === 1) {
		break;
	}

	console.log(`[drill] verdict was "${severity || "none"}", retrying once with sharper drill wording`);
	severity = "";
	eventId = injectDrillEvent(DETAILS[1]!);
}

const completed = severity === "high" ? await waitForChain(eventId, startedAt + DEADLINE_MS) : false;

console.log(`\n${"=".repeat(72)}`);
console.log("DRILL REPORT");
console.log("=".repeat(72));
console.log(`Wall clock:                ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`Guardrail mode:            ${guardrailMode()}`);
console.log(`Drill event:               ${eventId} (authority_change, source Drill)`);
console.log(`Analyst severity:          ${severity || "none"}`);
console.log(`Budget used:               ${state.inferenceBudget.used}/${state.inferenceBudget.max}`);
console.log(`Incidents:                 ${state.incidents.length}`);

for (const incident of state.incidents) {
	console.log(
		`  ${incident.id} eventId=${incident.eventId} source=${incident.source} correlated=${incident.correlated} [${incident.severity}] ${incident.summary.replace(/\s+/g, " ")}`,
	);
}

printGuardrailSection(state);
console.log(`Final brief:               ${state.brief.replace(/\s+/g, " ")}`);
console.log("=".repeat(72));

if (severity !== "high") {
	console.error(`DRILL FAIL: analyst rated the drill event "${severity || "none"}", not high, after two phrasings`);
	process.exit(1);
}

if (state.decisions.length === 0) {
	console.error("DRILL FAIL: no guardrail.decision was recorded");
	process.exit(1);
}

if (!completed || state.responderAcks.length === 0) {
	console.error("DRILL FAIL: the responder did not acknowledge the guardrail decision within the deadline");
	process.exit(1);
}

console.log(
	`DRILL PASS: ${state.decisions.map((d) => `${d.decision} by ${d.by}`).join(", ")}; responder acknowledged; ${state.actions.length} action(s) executed`,
);
setTimeout(() => process.exit(0), 50);
