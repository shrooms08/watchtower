import "dotenv/config";
import { SemanticEvent } from "@mozaik-ai/core";
import { answered } from "./completion";
import { echoAgent } from "./participants/echo-agent";
import { MODEL } from "./participants/echo-agent/situations/message-sent";
import { observer } from "./participants/observer";
import { user } from "./participants/user";
import { EnvironmentState, initializeRuntime, join, resolveRuntime, sendEvent, sendMessage } from "./runtime";

const PROMPT = "Reply with exactly: WATCHTOWER ONLINE";
const TIMEOUT_MS = 30_000;

initializeRuntime({ state: EnvironmentState.create(12) });

// Join the observer first so it witnesses everyone else joining.
join(observer);
join(user);
join(echoAgent);

// runLoop is fire-and-forget: a provider failure surfaces here, not at the call site.
process.on("unhandledRejection", (reason) => {
	console.error(`SMOKE FAIL: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
	process.exit(1);
});

const timeout = setTimeout(() => {
	console.error(`SMOKE FAIL: no model.answer within ${TIMEOUT_MS / 1000}s`);
	process.exit(1);
}, TIMEOUT_MS);

console.log(`[${new Date().toISOString()}] [main] model=${MODEL} sending: ${JSON.stringify(PROMPT)}`);
sendMessage(PROMPT, user.getId());

const answer = await answered;
clearTimeout(timeout);

// Prove custom events fan out to handlers exactly like runtime events.
sendEvent(SemanticEvent.create("chain.event", user.getId(), { step: 1, note: "answer received" }), user.getId());

const { eventLog } = resolveRuntime().state;
console.log(`[${new Date().toISOString()}] [main] shared state: ${eventLog.length} events logged`);
console.log(`SMOKE PASS: ${answer}`);

setTimeout(() => process.exit(0), 50);
