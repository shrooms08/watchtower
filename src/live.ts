import "dotenv/config";
import { MODEL } from "./agent-context";
import { analyst } from "./participants/analyst";
import { briefer } from "./participants/briefer";
import { observer } from "./participants/observer";
import { operator } from "./participants/operator";
import { createSolanaWatcher, DEFAULTS, startSolanaWatcher } from "./participants/solana-watcher";
import { peakConcurrency } from "./report";
import { EnvironmentState, initializeRuntime, join, resolveRuntime } from "./runtime";

const MAX_INFERENCES = 6;
const RUN_MS = 90_000;

const state = EnvironmentState.create(MAX_INFERENCES);
initializeRuntime({ state });
state.analystId = analyst.getId();

join(observer);
join(operator);
join(analyst);
join(briefer);

const solanaWatcher = createSolanaWatcher();
join(solanaWatcher);

process.on("unhandledRejection", (reason) => {
	console.error(`[live] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const startedAt = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`[live] model=${MODEL} budget=${MAX_INFERENCES} run=${RUN_MS / 1000}s`);
console.log(`[live] program=${DEFAULTS.programId}`);
console.log(`[live] ws=${DEFAULTS.wsUrl}`);
console.log(`[live] rpc=${DEFAULTS.rpcUrl}`);
console.log(`[live] largeTransferSol=${DEFAULTS.largeTransferSol}\n`);

const handle = startSolanaWatcher(solanaWatcher);

await sleep(RUN_MS);
await handle.stop();

// Let any inference still in flight land before reporting.
for (let i = 0; i < 40 && state.inFlight() > 0; i++) {
	await sleep(250);
}

const stats = handle.stats();
const peak = peakConcurrency(state.eventLog);
const nonHeartbeat = stats.emitted.large_transfer + stats.emitted.authority_change + stats.emitted.failed_burst;
const correlated = state.incidents.filter((incident) => incident.correlated);

console.log(`\n${"=".repeat(72)}`);
console.log("LIVE REPORT");
console.log("=".repeat(72));
console.log(`Wall clock:               ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`Program watched:          ${DEFAULTS.programId}`);
console.log("--- websocket / rpc ---");
console.log(`Logs received:            ${stats.logsReceived}`);
console.log(`Failed signatures:        ${stats.failed}`);
console.log(`Sampled (RPC fetched):    ${stats.sampled}`);
console.log(`Dropped (rate guard):     ${stats.dropped}`);
console.log(`RPC errors:               ${stats.rpcErrors}`);
console.log(`  of which HTTP 429:      ${stats.rateLimited}`);
console.log(`Reconnects:               ${stats.reconnects}`);
console.log(`Max inflow in a sample:   ${stats.maxSampledSol.toFixed(3)} SOL (threshold ${DEFAULTS.largeTransferSol} SOL)`);
console.log(`spl-token instrs scanned: ${stats.splTokenInstructions}`);
console.log(`Last error:               ${stats.lastError ?? "none"}`);
console.log("--- chain.events emitted ---");
console.log(`  large_transfer:         ${stats.emitted.large_transfer}`);
console.log(`  authority_change:       ${stats.emitted.authority_change}`);
console.log(`  failed_burst:           ${stats.emitted.failed_burst}`);
console.log(`  normal (heartbeat):     ${stats.emitted.normal}`);
console.log(`  non-heartbeat total:    ${nonHeartbeat}`);
console.log("--- agents ---");
console.log(`Skipped as normal:        ${state.skippedNormalCount}`);
console.log(`Sent to inference:        ${state.dispatchedCount}`);
console.log(`Blocked by budget:        ${state.budgetBlockedCount}`);
console.log(`Verdict parse failures:   ${state.parseFailureCount}`);
console.log(`Invalid payloads ignored: ${state.invalidPayloadCount}`);
console.log(`Peak concurrent infer.:   ${peak}`);
console.log(`Budget used:              ${state.inferenceBudget.used}/${state.inferenceBudget.max}`);
console.log(`Incidents:                ${state.incidents.length} (${correlated.length} correlated by eventId)`);

for (const incident of state.incidents) {
	console.log(
		`  ${incident.id} eventId=${incident.eventId} correlated=${incident.correlated} [${incident.severity}] ${incident.kind}: ${incident.summary.replace(/\s+/g, " ")}`,
	);
}

console.log(`Final brief:              ${state.brief.replace(/\s+/g, " ")}`);
console.log("=".repeat(72));

if (stats.logsReceived === 0) {
	console.error(`LIVE FAIL: no logs received (last websocket error: ${stats.lastError ?? "none"})`);
	process.exit(1);
}

console.log(
	`LIVE PASS: ${stats.logsReceived} logs, ${nonHeartbeat} non-heartbeat chain.events, ${correlated.length} correlated incidents`,
);
setTimeout(() => process.exit(0), 50);
