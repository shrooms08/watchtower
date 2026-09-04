import "dotenv/config";
import { modelSummary } from "./models";
import { analyst } from "./participants/analyst";
import { briefer } from "./participants/briefer";
import { correlator } from "./participants/correlator";
import { guardrail } from "./participants/guardrail";
import { observer } from "./participants/observer";
import { operator } from "./participants/operator";
import { responder } from "./participants/responder";
import { createSolanaWatcher, SolanaWatcher, WATCHER_DEFAULTS } from "./participants/solana-watcher";
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

const MAX_INFERENCES = 10;
const RUN_MS = 90_000;

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

// Two fully independent streams: own Connection, own websocket, own counters.
const streams: SolanaWatcher[] = [
	createSolanaWatcher({ name: "Jupiter Stream", programId: WATCHER_DEFAULTS.programId }),
	createSolanaWatcher({ name: "Pumpfun Stream", programId: WATCHER_DEFAULTS.programId2 }),
];

for (const stream of streams) {
	join(stream.participant);
}

process.on("unhandledRejection", (reason) => {
	console.error(`[live] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const startedAt = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`[live] models: ${modelSummary()} budget=${MAX_INFERENCES} run=${RUN_MS / 1000}s`);
console.log(`[live] ws=${WATCHER_DEFAULTS.wsUrl}`);
console.log(`[live] rpc=${WATCHER_DEFAULTS.rpcUrl}`);
console.log(`[live] largeTransferSol=${WATCHER_DEFAULTS.largeTransferSol}`);

for (const stream of streams) {
	const { name, programId } = stream.stats();
	console.log(`[live] stream "${name}" -> ${programId}`);
}

console.log("");

// Both streams start at the same time.
for (const stream of streams) {
	stream.start();
}

await sleep(RUN_MS);
await Promise.all(streams.map((stream) => stream.stop()));

// Let any inference still in flight land before reporting.
for (let i = 0; i < 40 && state.inFlight() > 0; i++) {
	await sleep(250);
}

const allStats = streams.map((stream) => stream.stats());
const peak = peakConcurrency(state.eventLog);
const found = overlaps(inferenceIntervals(state.eventLog));
const correlated = state.incidents.filter((incident) => incident.correlated);
const sum = (pick: (s: (typeof allStats)[number]) => number): number => allStats.reduce((n, s) => n + pick(s), 0);
const nonHeartbeat = sum((s) => s.emitted.large_transfer + s.emitted.authority_change + s.emitted.failed_burst);
const streamsWithEvents = allStats.filter(
	(s) => s.emitted.large_transfer + s.emitted.authority_change + s.emitted.failed_burst + s.emitted.normal > 0,
);

console.log(`\n${"=".repeat(72)}`);
console.log("LIVE REPORT");
console.log("=".repeat(72));
console.log(`Wall clock:               ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

for (const stats of allStats) {
	console.log(`--- stream: ${stats.name} (${stats.programId}) ---`);
	console.log(`  Logs received:          ${stats.logsReceived}`);
	console.log(`  Failed signatures:      ${stats.failed}`);
	console.log(`  Sampled (RPC fetched):  ${stats.sampled}`);
	console.log(`  Dropped (rate guard):   ${stats.dropped}`);
	console.log(`  RPC errors:             ${stats.rpcErrors}`);
	console.log(`    of which HTTP 429:    ${stats.rateLimited}`);
	console.log(`  Reconnects:             ${stats.reconnects}`);
	console.log(`  Max inflow in a sample: ${stats.maxSampledSol.toFixed(3)} SOL (threshold ${WATCHER_DEFAULTS.largeTransferSol})`);
	console.log(`  spl-token instrs:       ${stats.splTokenInstructions}`);
	console.log(`  Last error:             ${stats.lastError ?? "none"}`);
	console.log(
		`  Events: large_transfer=${stats.emitted.large_transfer} authority_change=${stats.emitted.authority_change} failed_burst=${stats.emitted.failed_burst} normal=${stats.emitted.normal}`,
	);
}

console.log("--- aggregate ---");
console.log(`Streams with events:      ${streamsWithEvents.length}/${allStats.length}`);
console.log(`Logs received:            ${sum((s) => s.logsReceived)}`);
console.log(`Failed signatures:        ${sum((s) => s.failed)}`);
console.log(`Sampled (RPC fetched):    ${sum((s) => s.sampled)}`);
console.log(`Dropped (rate guard):     ${sum((s) => s.dropped)}`);
console.log(`RPC errors:               ${sum((s) => s.rpcErrors)}`);
console.log(`  of which HTTP 429:      ${sum((s) => s.rateLimited)}`);
console.log(`Reconnects:               ${sum((s) => s.reconnects)}`);
console.log(`chain.events non-heartbeat: ${nonHeartbeat}`);
console.log(`chain.events heartbeat:   ${sum((s) => s.emitted.normal)}`);
console.log("--- agents ---");
console.log(`Skipped as normal:        ${state.skippedNormalCount}`);
console.log(`Sent to inference:        ${state.dispatchedCount}`);
console.log(`Blocked by budget:        ${state.budgetBlockedCount}`);
console.log(`Verdict parse failures:   ${state.parseFailureCount}`);
console.log(`Invalid payloads ignored: ${state.invalidPayloadCount}`);
console.log(`Budget used:              ${state.inferenceBudget.used}/${state.inferenceBudget.max}`);
console.log(`Incidents:                ${state.incidents.length} (${correlated.length} correlated by eventId)`);

for (const incident of state.incidents) {
	console.log(
		`  ${incident.id} eventId=${incident.eventId} source=${incident.source} correlated=${incident.correlated} [${incident.severity}] ${incident.kind}: ${incident.summary.replace(/\s+/g, " ")}`,
	);
}

printCorrelationsSection(state);
printGuardrailSection(state);
printBriefDecisionCheck(state);
console.log(`Final brief:              ${state.brief.replace(/\s+/g, " ")}`);
console.log(`Overlapping pairs:        ${found.length}`);

for (const overlap of found) {
	console.log(formatOverlap(overlap));
}

console.log(`Peak concurrency: ${peak}`);
console.log("=".repeat(72));

const totalLogs = sum((s) => s.logsReceived);

if (totalLogs === 0) {
	console.error(`LIVE FAIL: no logs received (last websocket error: ${allStats.map((s) => s.lastError).join(" | ")})`);
	process.exit(1);
}

console.log(
	`LIVE PASS: ${totalLogs} logs across ${streamsWithEvents.length} streams, ${nonHeartbeat} non-heartbeat chain.events, ${correlated.length} correlated incidents, peak concurrency ${peak}`,
);
setTimeout(() => process.exit(0), 50);
