import { createHuman, Human, SemanticEvent } from "@mozaik-ai/core";
import { sendEvent } from "../../runtime";

export type ChainName = "solana" | "base";
export type EventKind = "large_transfer" | "authority_change" | "failed_burst" | "normal";

export type ChainEventPayload = {
	chain: ChainName;
	txSig: string;
	kind: EventKind;
	amountUsd: number;
	wallet: string;
	ts: string;
};

type WatcherConfig = {
	chain: ChainName;
	intervalMs: number;
	kinds: readonly EventKind[];
};

/** Watchers are humans, not agents: they only produce events, never inference. */
const configs = new Map<string, WatcherConfig>();

const KIND_PATTERNS: Record<ChainName, readonly EventKind[]> = {
	// Half of each stream is "normal" and never reaches the model. Both chains
	// open with a risky event so the two analyst loops start close together.
	solana: ["large_transfer", "normal", "authority_change", "normal"],
	base: ["failed_burst", "normal", "large_transfer", "normal"],
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HEX = "0123456789abcdef";

function randomFrom(alphabet: string, length: number): string {
	let out = "";

	for (let i = 0; i < length; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}

	return out;
}

function fakeTxSig(chain: ChainName): string {
	return chain === "solana" ? randomFrom(BASE58, 44) : `0x${randomFrom(HEX, 64)}`;
}

function fakeWallet(chain: ChainName): string {
	return chain === "solana" ? randomFrom(BASE58, 32) : `0x${randomFrom(HEX, 40)}`;
}

function amountFor(kind: EventKind): number {
	switch (kind) {
		case "large_transfer":
			return Math.round(250_000 + Math.random() * 4_000_000);
		case "authority_change":
			return 0;
		case "failed_burst":
			return Math.round(Math.random() * 5_000);
		default:
			return Math.round(50 + Math.random() * 2_000);
	}
}

/** intervalMs +/- 40%. */
function jitter(intervalMs: number): number {
	return Math.round(intervalMs * (0.6 + Math.random() * 0.8));
}

export function createWatcher(chainName: ChainName, intervalMs: number): Human {
	const name = `${chainName === "solana" ? "Solana" : "Base"} Watcher`;
	const watcher = createHuman({ name, capabilities: [], handlers: [] });

	configs.set(watcher.getId(), { chain: chainName, intervalMs, kinds: KIND_PATTERNS[chainName] });

	return watcher;
}

/** Emits `count` chain.events on a jittered timer, then resolves. */
export function startWatcher(participant: Human, count: number): Promise<void> {
	const config = configs.get(participant.getId());

	if (!config) {
		throw new Error(`${participant.getManifest().name} was not created by createWatcher`);
	}

	return new Promise((resolve) => {
		let emitted = 0;

		const tick = (): void => {
			const kind = config.kinds[emitted % config.kinds.length]!;
			const payload: ChainEventPayload = {
				chain: config.chain,
				txSig: fakeTxSig(config.chain),
				kind,
				amountUsd: amountFor(kind),
				wallet: fakeWallet(config.chain),
				ts: new Date().toISOString(),
			};

			sendEvent(SemanticEvent.create("chain.event", participant.getId(), payload), participant.getId());
			emitted++;

			if (emitted >= count) {
				resolve();
				return;
			}

			setTimeout(tick, jitter(config.intervalMs));
		};

		setTimeout(tick, jitter(config.intervalMs));
	});
}
