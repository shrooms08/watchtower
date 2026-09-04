import "dotenv/config";
import { modelSummary } from "./models";
import { analyst } from "./participants/analyst";
import { briefer } from "./participants/briefer";
import { correlator } from "./participants/correlator";
import { guardrail } from "./participants/guardrail";
import { observer } from "./participants/observer";
import { operator } from "./participants/operator";
import { responder } from "./participants/responder";
import { createWatcher, startWatcher } from "./participants/watcher";
import {
	formatOverlap,
	inferenceIntervals,
	overlaps,
	peakConcurrency,
	printBriefDecisionCheck,
	printCorrelationsSection,
	printGuardrailSection,
} from "./report";
import { EnvironmentState, initializeRuntime, join, resolveRuntime } from "./runtime";

const MAX_INFERENCES = 12;
const EVENTS_PER_WATCHER = 4;
const QUIET_MS = 5_000;
const HARD_TIMEOUT_MS = 60_000;

const state = EnvironmentState.create(MAX_INFERENCES);
initializeRuntime({ state });
state.analystId = analyst.getId();

// Observer first, so it witnesses every later join.
join(observer);
join(guardrail);
join(operator);
join(analyst);
join(briefer);
join(correlator);
join(responder);

const solanaWatcher = createWatcher("solana", 1500);
const baseWatcher = createWatcher("base", 2200);

join(solanaWatcher);
join(baseWatcher);

// runLoop is fire-and-forget: a provider failure lands here, not at the call site.
process.on("unhandledRejection", (reason) => {
	console.error(`CONCURRENCY FAIL: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
	process.exit(1);
});

const startedAt = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`[main] models: ${modelSummary()} budget=${MAX_INFERENCES} watchers=2 x ${EVENTS_PER_WATCHER} events\n`);

// Both watchers run at once so their streams interleave.
const watchersDone = Promise.all([
	startWatcher(solanaWatcher, EVENTS_PER_WATCHER),
	startWatcher(baseWatcher, EVENTS_PER_WATCHER),
]);

let watchersFinished = false;
void watchersDone.then(() => {
	watchersFinished = true;
});

let timedOut = false;

while (true) {
	if (Date.now() - startedAt >= HARD_TIMEOUT_MS) {
		timedOut = true;
		break;
	}

	if (watchersFinished && state.inFlight() === 0 && Date.now() - state.lastInferenceActivity >= QUIET_MS) {
		break;
	}

	await sleep(250);
}

const chainEvents = state.eventLog.filter((entry) => entry.type === "chain.event").length;
const inferenceStarts = state.eventLog.filter((entry) => entry.type === "inference.started").length;
const intervals = inferenceIntervals(state.eventLog);
const found = overlaps(intervals);
const peak = peakConcurrency(state.eventLog);

console.log(`\n${"=".repeat(72)}`);
console.log("CONCURRENCY REPORT");
console.log("=".repeat(72));
console.log(`Wall clock:               ${((Date.now() - startedAt) / 1000).toFixed(1)}s${timedOut ? " (HARD TIMEOUT)" : ""}`);
console.log(`Total chain.events:       ${chainEvents}`);
console.log(`Skipped as normal:        ${state.skippedNormalCount}`);
console.log(`Blocked by budget:        ${state.budgetBlockedCount}`);
console.log(`Sent to inference:        ${state.dispatchedCount} chain.events -> analyst runLoops`);
console.log(`Total runLoop calls:      ${state.inferenceBudget.used} (analyst ${state.dispatchedCount} + briefer ${state.inferenceBudget.used - state.dispatchedCount})`);
console.log(`inference.started events: ${inferenceStarts}`);
console.log(`Peak concurrent infer.:   ${peak}`);
console.log(`Overlapping pairs:        ${found.length}`);

for (const overlap of found) {
	console.log(formatOverlap(overlap));
}

console.log(`Incidents recorded:       ${state.incidents.length}`);

for (const incident of state.incidents) {
	console.log(`  ${incident.id} [${incident.severity}] ${incident.chain}: ${incident.summary.replace(/\s+/g, " ")}`);
}

console.log(`Budget used:              ${state.inferenceBudget.used}/${state.inferenceBudget.max}`);
printCorrelationsSection(state);
printGuardrailSection(state);
printBriefDecisionCheck(state);
console.log(`Final brief:              ${state.brief.replace(/\s+/g, " ")}`);
console.log("=".repeat(72));

if (peak <= 1) {
	console.error("CONCURRENCY FAIL: inferences ran sequentially");
	process.exit(1);
}

console.log(`CONCURRENCY PASS: peak ${peak} inferences in flight at once`);
setTimeout(() => process.exit(0), 50);
