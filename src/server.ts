import "dotenv/config";

// The interceptor reads this at decision time, so setting it here is enough.
process.env.GUARDRAIL_MODE ??= "ui";

import { SemanticEvent } from "@mozaik-ai/core";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join as joinPath } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { newEventId, type ChainEventPayload } from "./chain-event";
import { modelSummary } from "./models";
import { analyst } from "./participants/analyst";
import { briefer } from "./participants/briefer";
import { correlator } from "./participants/correlator";
import { guardrail } from "./participants/guardrail";
import { observer } from "./participants/observer";
import { operator, recordOperatorDecision } from "./participants/operator";
import { responder } from "./participants/responder";
import { createSolanaWatcher, SolanaWatcher, WATCHER_DEFAULTS } from "./participants/solana-watcher";
import { uiObserver } from "./participants/ui-observer";
import { EnvironmentState, initializeRuntime, join, resolveRuntime, sendEvent, sendMessage } from "./runtime";
import { history, subscribe, type Envelope } from "./stream";

const PORT = Number(process.env.PORT ?? 4400);
const BUDGET = Number(process.env.SERVE_BUDGET ?? 200);
const ANALYST_PER_MIN = Number(process.env.ANALYST_PER_MIN ?? 4);

const state = EnvironmentState.create(BUDGET, ANALYST_PER_MIN);
initializeRuntime({ state });
state.analystId = analyst.getId();

join(observer);
join(uiObserver);
join(guardrail);
join(operator);
join(analyst);
join(briefer);
join(correlator);
join(responder);

const streams: SolanaWatcher[] = [
	createSolanaWatcher({ name: "Jupiter Stream", programId: WATCHER_DEFAULTS.programId }),
	createSolanaWatcher({ name: "Pumpfun Stream", programId: WATCHER_DEFAULTS.programId2 }),
];

for (const stream of streams) {
	join(stream.participant);
}

const lastEventTs = new Map<string, string>();

state.watcherStatsProvider = () =>
	streams.map((stream) => {
		const stats = stream.stats();

		return {
			name: stats.name,
			programId: stats.programId,
			logs: stats.logsReceived,
			failed: stats.failed,
			sampled: stats.sampled,
			dropped: stats.dropped,
			rpcErrors: stats.rpcErrors,
			rateLimited: stats.rateLimited,
			reconnects: stats.reconnects,
			emitted: stats.emitted,
			lastEventTs: lastEventTs.get(stats.name) ?? null,
		};
	});

// Stamp each stream's last emitted chain.event, for the dashboard's liveness dot.
subscribe((envelope) => {
	if (envelope.type === "chain.event") {
		lastEventTs.set(envelope.producer, envelope.ts);
	}
});

process.on("unhandledRejection", (reason) => {
	console.error(`[serve] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const startedAt = Date.now();

function snapshot(): Record<string, unknown> {
	const runtime = resolveRuntime();

	return {
		participants: runtime.state.getParticipants().map((participant) => {
			const manifest = participant.getManifest();

			return { name: manifest.name, role: manifest.role };
		}),
		incidents: state.incidents,
		correlations: state.correlations,
		brief: state.brief,
		operatorAnswers: state.operatorAnswers,
		pendingApprovals: [...state.pendingApprovals.values()].filter(
			(pending) => state.decisionFor(pending.pendingId) === undefined,
		),
		decisions: state.decisions,
		actions: state.actions,
		budget: { used: state.inferenceBudget.used, max: state.inferenceBudget.max },
		analystRate: { usedThisMinute: state.analystUsedThisMinute(), max: state.analystPerMin, rateLimited: state.analystRateLimitedCount },
		watcherStats: state.watcherStats(),
		uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
	};
}

// -- drill injection into the running environment ---------------------------

const DRILL_WALLET = "9xKqRmT4vN2sBhP7yLzEwUdFgC5jXaQnV8MkZrH3TbSy";

function inject(overrides: Partial<ChainEventPayload> & { detail: string }): string {
	const payload: ChainEventPayload = {
		eventId: newEventId(),
		chain: "solana",
		source: "Drill-Solana",
		txSig: "DriLL1111111111111111111111111111111111111111",
		kind: "authority_change",
		amountUsd: 4_800_000,
		wallet: DRILL_WALLET,
		ts: new Date().toISOString(),
		...overrides,
	};

	sendEvent(SemanticEvent.create("chain.event", operator.getId(), payload), operator.getId());

	return payload.eventId;
}

function runDrill(mode: "single" | "multi"): string[] {
	if (mode === "single") {
		return [
			inject({
				detail:
					"Program upgrade authority reassigned to an unknown wallet 9xK..., and in the same slot the entire 4.8M USDC vault balance was drained to that wallet. The multisig did not sign and no governance proposal exists.",
			}),
		];
	}

	const first = inject({
		amountUsd: 0,
		detail:
			"Program upgrade authority moved from the 3-of-5 multisig to a single unknown wallet. No governance proposal exists and no multisig signature was recorded.",
	});

	const ids = [first];

	setTimeout(() => {
		ids.push(
			inject({
				source: "Drill-Base",
				chain: "base",
				kind: "large_transfer",
				detail:
					"4.8M USDC bridged out immediately after the authority change on the other chain, to the same wallet that received the upgrade authority.",
			}),
		);
	}, 2_000);

	return ids;
}

// -- http -------------------------------------------------------------------

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "content-type",
	"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);

	response.writeHead(status, { ...CORS, "content-type": "application/json" });
	response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];

	for await (const chunk of request) {
		chunks.push(chunk as Buffer);

		if (Buffer.concat(chunks).length > 64_000) {
			throw new Error("body too large");
		}
	}

	if (chunks.length === 0) {
		return {};
	}

	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));

	return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

const server = createServer((request, response) => {
	void (async () => {
		try {
			const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);

			if (request.method === "OPTIONS") {
				response.writeHead(204, CORS);
				response.end();
				return;
			}

			if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
				const page = await readFile(joinPath(process.cwd(), "public", "index.html"), "utf8");

				response.writeHead(200, { ...CORS, "content-type": "text/html; charset=utf-8" });
				response.end(page);
				return;
			}

			if (request.method === "GET" && url.pathname === "/debug") {
				const page = await readFile(joinPath(process.cwd(), "public", "debug.html"), "utf8");

				response.writeHead(200, { ...CORS, "content-type": "text/html; charset=utf-8" });
				response.end(page);
				return;
			}

			if (request.method === "GET" && url.pathname === "/api/state") {
				sendJson(response, 200, snapshot());
				return;
			}

			if (request.method === "GET" && url.pathname === "/api/events") {
				const since = Number(url.searchParams.get("since") ?? 0);

				sendJson(response, 200, { events: history(Number.isFinite(since) ? since : 0) });
				return;
			}

			if (request.method === "POST" && url.pathname === "/api/operator/message") {
				const body = await readBody(request);
				const text = typeof body.text === "string" ? body.text.trim() : "";

				if (!text) {
					sendJson(response, 400, { ok: false, error: "text is required" });
					return;
				}

				sendMessage(text, operator.getId());
				sendJson(response, 200, { ok: true });
				return;
			}

			if (request.method === "POST" && url.pathname === "/api/guardrail/decision") {
				const body = await readBody(request);
				const pendingId = typeof body.pendingId === "string" ? body.pendingId : "";
				const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : undefined;

				if (!decision) {
					sendJson(response, 400, { ok: false, error: 'decision must be "approved" or "rejected"' });
					return;
				}

				if (!state.getPending(pendingId)) {
					sendJson(response, 404, { ok: false, error: `unknown pendingId ${pendingId}` });
					return;
				}

				// Same path the Operator's /approve message uses.
				const result = recordOperatorDecision(
					pendingId,
					decision,
					typeof body.reason === "string" && body.reason ? body.reason : "decided in the UI",
				);

				sendJson(response, 200, { ok: true, alreadyDecided: !result.ok && result.reason === "already decided" });
				return;
			}

			if (request.method === "POST" && url.pathname === "/api/drill") {
				const body = await readBody(request);
				const mode = body.mode === "multi" ? "multi" : "single";

				sendJson(response, 200, { ok: true, mode, eventIds: runDrill(mode) });
				return;
			}

			sendJson(response, 404, { ok: false, error: "not found" });
		} catch (error) {
			sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	})();
});

// -- websocket --------------------------------------------------------------

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket: WebSocket) => {
	const send = (message: unknown): void => {
		if (socket.readyState === socket.OPEN) {
			socket.send(JSON.stringify(message));
		}
	};

	send({ type: "hello", state: snapshot() });

	for (const envelope of history()) {
		send(envelope);
	}

	const unsubscribe = subscribe((envelope: Envelope) => send(envelope));

	socket.on("close", unsubscribe);
	socket.on("error", unsubscribe);
});

server.listen(PORT, () => {
	console.log(`[serve] models: ${modelSummary()}`);
	console.log(`[serve] budget=${BUDGET} analystPerMin=${ANALYST_PER_MIN} guardrail=${process.env.GUARDRAIL_MODE}`);
	console.log(`[serve] guardrail timeout=${Number(process.env.GUARDRAIL_TIMEOUT_MS ?? 120_000) / 1000}s`);
	console.log(`[serve] http://localhost:${PORT}  ws://localhost:${PORT}/ws`);

	for (const stream of streams) {
		stream.start();
		console.log(`[serve] stream "${stream.stats().name}" -> ${stream.stats().programId}`);
	}
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	console.log("\n[serve] shutting down");

	// Stop accepting first, then let each watcher abandon its socket on timeout.
	for (const client of wss.clients) {
		client.terminate();
	}

	wss.close();
	server.close();

	await Promise.all(streams.map((stream) => stream.stop()));

	console.log("[serve] stopped");
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
