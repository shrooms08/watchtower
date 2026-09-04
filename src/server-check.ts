import "dotenv/config";
import { WebSocket } from "ws";
import type { Envelope } from "./stream";

/**
 * End-to-end check against a running `pnpm serve`. Drives the whole chain the
 * dashboard will drive tomorrow: drill -> verdict -> guardrail -> UI rejection
 * -> responder acknowledgement -> operator question, asserting the brief is not
 * clobbered by the answer.
 */
const PORT = Number(process.env.PORT ?? 4400);
const BASE = `http://localhost:${PORT}`;
const CHAIN_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 30_000;

const received: Envelope[] = [];
const failures: string[] = [];

/**
 * The server replays its ring buffer on connect, so every assertion has to
 * ignore anything that happened before this run: otherwise a matching envelope
 * from an earlier session satisfies the wait instantly and the check passes
 * without testing anything.
 */
let baselineSeq = 0;

const api = async (path: string, body?: unknown): Promise<any> => {
	const response = await fetch(`${BASE}${path}`, {
		method: body ? "POST" : "GET",
		headers: { "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});

	return { status: response.status, json: await response.json().catch(() => ({})) };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (predicate()) {
			console.log(`  ok   ${label}`);
			return true;
		}

		await sleep(200);
	}

	console.error(`  FAIL ${label} (waited ${timeoutMs / 1000}s)`);
	failures.push(label);
	return false;
}

/** Polls /api/state: the server records an answer a beat after broadcasting it. */
async function waitForState(label: string, predicate: (state: any) => boolean, timeoutMs: number): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let latest: any = {};

	while (Date.now() < deadline) {
		latest = (await api("/api/state")).json;

		if (predicate(latest)) {
			console.log(`  ok   ${label}`);
			return latest;
		}

		await sleep(500);
	}

	console.error(`  FAIL ${label} (waited ${timeoutMs / 1000}s)`);
	failures.push(label);
	return latest;
}

const seen = (predicate: (envelope: Envelope) => boolean): boolean =>
	received.some((envelope) => envelope.seq > baselineSeq && predicate(envelope));

const socket = new WebSocket(`ws://localhost:${PORT}/ws`);

await new Promise<void>((resolve, reject) => {
	socket.once("open", () => resolve());
	socket.once("error", reject);
	setTimeout(() => reject(new Error("websocket did not open within 10s")), 10_000);
});

socket.on("message", (raw) => {
	try {
		const data = JSON.parse(String(raw));

		if (data && data.type !== "hello" && typeof data.seq === "number") {
			received.push(data as Envelope);
		}
	} catch {
		// ignore anything that is not an envelope
	}
});

// Let the replayed history arrive, then draw the line under it.
await sleep(1_500);
baselineSeq = received.reduce((max, envelope) => Math.max(max, envelope.seq), 0);
console.log(`CHECK: connected to /ws, ignoring ${received.length} replayed envelopes (baseline seq ${baselineSeq})`);

const before = await api("/api/state");
const briefBefore = String(before.json.brief ?? "");
const startedAt = Date.now();

const drill = await api("/api/drill", { mode: "single" });

if (!drill.json.ok) {
	failures.push("POST /api/drill did not return ok");
}

console.log(`CHECK: injected drill ${JSON.stringify(drill.json.eventIds ?? [])}`);

await waitFor("chain.event envelope", () => seen((e) => e.type === "chain.event"), CHAIN_TIMEOUT_MS);
await waitFor(
	"model.answer from Risk Analyst",
	() => seen((e) => e.type === "model.answer" && e.producer === "Risk Analyst"),
	CHAIN_TIMEOUT_MS - (Date.now() - startedAt),
);
await waitFor(
	"guardrail.pending envelope",
	() => seen((e) => e.type === "guardrail.pending"),
	Math.max(5_000, CHAIN_TIMEOUT_MS - (Date.now() - startedAt)),
);

const pendingEnvelope = received.find((e) => e.seq > baselineSeq && e.type === "guardrail.pending");
const pendingId = pendingEnvelope ? String((pendingEnvelope.payload as { pendingId?: string }).pendingId ?? "") : "";

if (!pendingId) {
	failures.push("no pendingId in the guardrail.pending envelope");
} else {
	console.log(`CHECK: rejecting ${pendingId} over HTTP`);

	const posted = await api("/api/guardrail/decision", { pendingId, decision: "rejected", reason: "server-check" });

	if (posted.status !== 200 || !posted.json.ok) {
		failures.push(`POST /api/guardrail/decision returned ${posted.status}`);
	}

	await waitFor(
		"guardrail.decision envelope",
		() => seen((e) => e.type === "guardrail.decision"),
		20_000,
	);
	await waitFor(
		"model.answer from Responder (acknowledgement)",
		() => seen((e) => e.type === "model.answer" && e.producer === "Responder"),
		30_000,
	);
}

const question = "what happened in the drill?";
const answersBefore = (await api("/api/state")).json.operatorAnswers?.length ?? 0;

console.log(`CHECK: asking "${question}"`);
await api("/api/operator/message", { text: question });

await waitFor(
	"operator_answer envelope",
	() => seen((e) => e.type === "model.answer" && (e.payload as { kind?: string }).kind === "operator_answer"),
	ANSWER_TIMEOUT_MS,
);

const after = await waitForState(
	"operatorAnswer recorded in /api/state",
	(s) => (s.operatorAnswers ?? []).length > answersBefore,
	20_000,
);
const answers = after.operatorAnswers ?? [];
const answerText = answers.length > 0 ? String(answers[answers.length - 1].answer) : "";

if (answers.length > answersBefore) {
	console.log(`       ${answerText.replace(/\s+/g, " ").slice(0, 100)}`);
}

const briefAfter = String(after.brief ?? "");

if (answerText && briefAfter.trim() === answerText.trim()) {
	failures.push("state.brief was overwritten with the operator answer");
} else {
	console.log(`  ok   brief was not replaced by the answer (brief ${briefBefore === briefAfter ? "unchanged" : "changed independently"})`);
}

socket.close();

if (failures.length > 0) {
	console.error(`\nCHECK FAIL (${failures.length}):`);

	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}

	process.exit(1);
}

console.log(`\nCHECK PASS: ${received.length} envelopes, drill -> verdict -> guardrail -> rejection -> ack -> operator answer`);
process.exit(0);
