import { createHuman, Human, SemanticEvent } from "@mozaik-ai/core";
import {
	Connection,
	PublicKey,
	type Logs,
	type ParsedInstruction,
	type ParsedTransactionWithMeta,
	type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { ChainEventPayload, EventKind, newEventId } from "../../chain-event";
import { sendEvent } from "../../runtime";

export type SolanaWatcherConfig = {
	/** Stream label, carried on every payload as `source`. */
	name: string;
	programId: string;
	wsUrl: string;
	rpcUrl: string;
	largeTransferSol: number;
	/** At most one sampled RPC fetch per this many ms, per watcher. */
	sampleIntervalMs: number;
	heartbeatMs: number;
	failedWindowMs: number;
	failedThreshold: number;
	failedSuppressMs: number;
	staleAfterMs: number;
	maxReconnects: number;
	reconnectDelayMs: number;
	/** Cap on waiting for the websocket unsubscribe ack when stopping. */
	unsubscribeTimeoutMs: number;
};

export type SolanaWatcherStats = {
	name: string;
	programId: string;
	logsReceived: number;
	failed: number;
	sampled: number;
	dropped: number;
	rpcErrors: number;
	rateLimited: number;
	reconnects: number;
	emitted: Record<EventKind, number>;
	/** Largest positive-lamport-delta total seen in a sampled tx, in SOL. */
	maxSampledSol: number;
	/** spl-token instructions scanned for setAuthority. */
	splTokenInstructions: number;
	lastError: string | undefined;
};

export type SolanaWatcher = {
	participant: Human;
	start(): void;
	stats(): SolanaWatcherStats;
	stop(): Promise<void>;
};

export const WATCHER_DEFAULTS = {
	wsUrl: process.env.SOLANA_WS_URL ?? "wss://api.mainnet-beta.solana.com",
	rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
	// Jupiter v6
	programId: process.env.WATCH_PROGRAM_SOLANA ?? "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
	// Pump.fun
	programId2: process.env.WATCH_PROGRAM_SOLANA_2 ?? "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
	largeTransferSol: Number(process.env.LARGE_TRANSFER_SOL ?? 50),
	sampleIntervalMs: 3_000,
	heartbeatMs: 10_000,
	failedWindowMs: 10_000,
	failedThreshold: 5,
	failedSuppressMs: 30_000,
	staleAfterMs: 30_000,
	maxReconnects: 5,
	reconnectDelayMs: 3_000,
	unsubscribeTimeoutMs: 3_000,
} as const;

const LAMPORTS_PER_SOL = 1_000_000_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimit(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);

	return message.includes("429") || message.toLowerCase().includes("too many requests");
}

/** Flattens top-level and inner instructions into one list. */
function allInstructions(tx: ParsedTransactionWithMeta): (ParsedInstruction | PartiallyDecodedInstruction)[] {
	const top = tx.transaction.message.instructions;
	const inner = (tx.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions);

	return [...top, ...inner];
}

/**
 * One self-contained live stream. Every instance builds its own Connection (so
 * its own websocket), its own failure window, suppression clock, sampling clock,
 * reconnect state and counters. Two instances share nothing but the runtime and
 * the shared EnvironmentState.
 */
export function createSolanaWatcher(
	options: { name: string; programId: string; wsUrl?: string; rpcUrl?: string } & Partial<SolanaWatcherConfig>,
): SolanaWatcher {
	const config: SolanaWatcherConfig = {
		largeTransferSol: WATCHER_DEFAULTS.largeTransferSol,
		sampleIntervalMs: WATCHER_DEFAULTS.sampleIntervalMs,
		heartbeatMs: WATCHER_DEFAULTS.heartbeatMs,
		failedWindowMs: WATCHER_DEFAULTS.failedWindowMs,
		failedThreshold: WATCHER_DEFAULTS.failedThreshold,
		failedSuppressMs: WATCHER_DEFAULTS.failedSuppressMs,
		staleAfterMs: WATCHER_DEFAULTS.staleAfterMs,
		maxReconnects: WATCHER_DEFAULTS.maxReconnects,
		reconnectDelayMs: WATCHER_DEFAULTS.reconnectDelayMs,
		unsubscribeTimeoutMs: WATCHER_DEFAULTS.unsubscribeTimeoutMs,
		wsUrl: WATCHER_DEFAULTS.wsUrl,
		rpcUrl: WATCHER_DEFAULTS.rpcUrl,
		...options,
	};

	const participant = createHuman({ name: config.name, capabilities: [], handlers: [] });
	const programKey = new PublicKey(config.programId);
	// Its own Connection, therefore its own websocket.
	const connection = new Connection(config.rpcUrl, { wsEndpoint: config.wsUrl, commitment: "confirmed" });

	const stats: SolanaWatcherStats = {
		name: config.name,
		programId: config.programId,
		logsReceived: 0,
		failed: 0,
		sampled: 0,
		dropped: 0,
		rpcErrors: 0,
		rateLimited: 0,
		reconnects: 0,
		emitted: { large_transfer: 0, authority_change: 0, failed_burst: 0, normal: 0 },
		maxSampledSol: 0,
		splTokenInstructions: 0,
		lastError: undefined,
	};

	// Per-heartbeat-window counters.
	let window = { seen: 0, failed: 0, sampled: 0, dropped: 0 };

	const recentFailures: { ts: number; signature: string }[] = [];
	let failedSuppressedUntil = 0;
	let lastSampleAt = 0;
	let fetchInFlight = false;
	let lastLogAt = Date.now();
	let subscriptionId: number | undefined;
	let stopped = false;
	let heartbeat: NodeJS.Timeout | undefined;
	let watchdog: NodeJS.Timeout | undefined;

	function emit(kind: EventKind, txSig: string, wallet: string, detail: string, amountSol?: number): void {
		const payload: ChainEventPayload = {
			eventId: newEventId(),
			chain: "solana",
			source: config.name,
			txSig,
			kind,
			amountUsd: 0,
			...(amountSol === undefined ? {} : { amountSol }),
			wallet,
			ts: new Date().toISOString(),
			detail,
		};

		stats.emitted[kind]++;
		sendEvent(SemanticEvent.create("chain.event", participant.getId(), payload), participant.getId());
	}

	function noteFailure(signature: string): void {
		const now = Date.now();

		recentFailures.push({ ts: now, signature });

		while (recentFailures.length > 0 && now - recentFailures[0]!.ts > config.failedWindowMs) {
			recentFailures.shift();
		}

		if (recentFailures.length < config.failedThreshold || now < failedSuppressedUntil) {
			return;
		}

		const last3 = recentFailures.slice(-3).map((entry) => entry.signature);

		emit(
			"failed_burst",
			last3[last3.length - 1] ?? "unknown",
			"n/a",
			`${recentFailures.length} failed txs in ${config.failedWindowMs / 1000}s; last: ${last3.join(", ")}`,
		);

		failedSuppressedUntil = now + config.failedSuppressMs;
		recentFailures.length = 0;
	}

	async function getParsed(signature: string): Promise<ParsedTransactionWithMeta | null> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await connection.getParsedTransaction(signature, {
					maxSupportedTransactionVersion: 0,
					commitment: "confirmed",
				});
			} catch (error) {
				stats.rpcErrors++;
				stats.lastError = error instanceof Error ? error.message : String(error);

				if (attempt === 0 && isRateLimit(error)) {
					stats.rateLimited++;
					console.warn(`[${config.name}] 429 on ${signature.slice(0, 12)}..., retrying once in 2s`);
					await sleep(2_000);
					continue;
				}

				return null;
			}
		}

		return null;
	}

	function inspect(tx: ParsedTransactionWithMeta, signature: string): void {
		const meta = tx.meta;

		if (!meta) {
			return;
		}

		// large_transfer: sum of positive lamport deltas across accounts.
		const keys = tx.transaction.message.accountKeys;
		let totalIn = 0;
		let topAccount = "unknown";
		let topDelta = 0;

		for (let i = 0; i < meta.postBalances.length; i++) {
			const delta = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);

			if (delta > 0) {
				totalIn += delta;

				if (delta > topDelta) {
					topDelta = delta;
					topAccount = keys[i]?.pubkey.toBase58() ?? "unknown";
				}
			}
		}

		stats.maxSampledSol = Math.max(stats.maxSampledSol, totalIn / LAMPORTS_PER_SOL);

		if (totalIn >= config.largeTransferSol * LAMPORTS_PER_SOL) {
			const amountSol = totalIn / LAMPORTS_PER_SOL;

			emit(
				"large_transfer",
				signature,
				topAccount,
				`${amountSol.toFixed(2)} SOL received across accounts, top ${topAccount.slice(0, 8)}... +${(topDelta / LAMPORTS_PER_SOL).toFixed(2)} SOL`,
				amountSol,
			);
		}

		// authority_change: any spl-token setAuthority*, top level or inner.
		for (const instruction of allInstructions(tx)) {
			if (!("parsed" in instruction) || instruction.program !== "spl-token") {
				continue;
			}

			stats.splTokenInstructions++;

			const parsed = instruction.parsed as { type?: unknown; info?: Record<string, unknown> } | undefined;
			const type = typeof parsed?.type === "string" ? parsed.type : "";

			if (!type.startsWith("setAuthority")) {
				continue;
			}

			const account = String(parsed?.info?.account ?? parsed?.info?.mint ?? "unknown");

			emit("authority_change", signature, account, `spl-token ${type} on ${account}`);
			break;
		}
	}

	function maybeSample(signature: string): void {
		const now = Date.now();

		// One fetch in flight per watcher, spaced by sampleIntervalMs.
		if (fetchInFlight || now - lastSampleAt < config.sampleIntervalMs) {
			stats.dropped++;
			window.dropped++;
			return;
		}

		fetchInFlight = true;
		lastSampleAt = now;

		void (async () => {
			try {
				const tx = await getParsed(signature);

				if (tx) {
					stats.sampled++;
					window.sampled++;
					inspect(tx, signature);
				}
			} catch (error) {
				stats.rpcErrors++;
				stats.lastError = error instanceof Error ? error.message : String(error);
			} finally {
				fetchInFlight = false;
			}
		})();
	}

	function onLogs(logs: Logs): void {
		try {
			lastLogAt = Date.now();
			stats.logsReceived++;
			window.seen++;

			if (logs.err !== null) {
				stats.failed++;
				window.failed++;
				noteFailure(logs.signature);
				return;
			}

			maybeSample(logs.signature);
		} catch (error) {
			// The web3.js callback must never throw back into the socket.
			stats.lastError = error instanceof Error ? error.message : String(error);
			console.error(`[${config.name}] log handler error: ${stats.lastError}`);
		}
	}

	async function subscribe(): Promise<void> {
		subscriptionId = await connection.onLogs(programKey, onLogs, "confirmed");
		lastLogAt = Date.now();
		console.log(`[${config.name}] subscribed to ${config.programId.slice(0, 8)}... (sub ${subscriptionId})`);
	}

	async function reconnect(reason: string): Promise<void> {
		if (stopped) {
			return;
		}

		if (stats.reconnects >= config.maxReconnects) {
			console.error(`[${config.name}] giving up after ${stats.reconnects} reconnects (${reason})`);
			return;
		}

		stats.reconnects++;
		stats.lastError = reason;
		console.warn(
			`[${config.name}] ${reason} - resubscribing in ${config.reconnectDelayMs / 1000}s (attempt ${stats.reconnects}/${config.maxReconnects})`,
		);

		try {
			if (subscriptionId !== undefined) {
				await connection.removeOnLogsListener(subscriptionId);
			}
		} catch {
			// the socket is already gone; nothing to remove
		}

		subscriptionId = undefined;
		await sleep(config.reconnectDelayMs);

		if (stopped) {
			return;
		}

		try {
			await subscribe();
		} catch (error) {
			void reconnect(`resubscribe failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function start(): void {
		// web3.js v1 keeps its socket private; hook it when present, and fall back
		// to a staleness watchdog so a silent death still triggers a resubscribe.
		const socket = (
			connection as unknown as { _rpcWebSocket?: { on?: (event: string, fn: (arg: unknown) => void) => void } }
		)._rpcWebSocket;

		if (typeof socket?.on === "function") {
			socket.on("error", (error: unknown) => {
				void reconnect(`websocket error: ${error instanceof Error ? error.message : String(error)}`);
			});
			socket.on("close", () => {
				void reconnect("websocket closed");
			});
		}

		watchdog = setInterval(() => {
			if (!stopped && Date.now() - lastLogAt > config.staleAfterMs) {
				void reconnect(`no logs for ${config.staleAfterMs / 1000}s`);
				lastLogAt = Date.now();
			}
		}, 5_000);

		heartbeat = setInterval(() => {
			if (stopped) {
				return;
			}

			const counts = window;
			window = { seen: 0, failed: 0, sampled: 0, dropped: 0 };

			emit(
				"normal",
				`heartbeat-${Date.now()}`,
				config.programId,
				`window seen=${counts.seen} failed=${counts.failed} sampled=${counts.sampled} dropped=${counts.dropped}`,
			);
		}, config.heartbeatMs);

		void subscribe().catch((error) => {
			void reconnect(`initial subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	return {
		participant,
		start,
		stats: () => ({ ...stats, emitted: { ...stats.emitted } }),
		stop: async () => {
			stopped = true;

			if (heartbeat) clearInterval(heartbeat);
			if (watchdog) clearInterval(watchdog);

			if (subscriptionId === undefined) {
				return;
			}

			// removeOnLogsListener waits for an unsubscribe ack over the same socket
			// the firehose is saturating; on a busy program that can block for over a
			// minute, so never wait on it unbounded.
			const unsubscribed = connection.removeOnLogsListener(subscriptionId).then(
				() => true,
				() => true,
			);

			const settled = await Promise.race([unsubscribed, sleep(config.unsubscribeTimeoutMs).then(() => false)]);

			if (!settled) {
				console.warn(`[${config.name}] unsubscribe timed out, abandoning socket`);
			}
		},
	};
}
