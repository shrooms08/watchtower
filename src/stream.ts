/**
 * The broadcast bus between the UI Observer and the server. Kept separate so
 * the participant never imports the transport, and so the ring buffer survives
 * clients connecting and disconnecting.
 */
export type Envelope = {
	seq: number;
	ts: string;
	type: string;
	producer: string;
	producerRole: string;
	inflight: number;
	payload: Record<string, unknown>;
};

const RING_SIZE = 500;

const ring: Envelope[] = [];
const listeners = new Set<(envelope: Envelope) => void>();
let seq = 0;

export function nextSeq(): number {
	return ++seq;
}

export function publishEnvelope(envelope: Envelope): void {
	ring.push(envelope);

	while (ring.length > RING_SIZE) {
		ring.shift();
	}

	for (const listener of listeners) {
		try {
			listener(envelope);
		} catch {
			// a dead socket must never break the event bus
		}
	}
}

export function subscribe(listener: (envelope: Envelope) => void): () => void {
	listeners.add(listener);

	return () => {
		listeners.delete(listener);
	};
}

/** Buffered history, oldest first; `since` is exclusive. */
export function history(since = 0): Envelope[] {
	return ring.filter((envelope) => envelope.seq > since);
}
