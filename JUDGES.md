# Watchtower: a five-minute guide for judges

A live security ops room for Solana protocols, run by concurrent agents on Mozaik 4.0.0.
Two watchers stream real mainnet activity, four agents grade, link, brief, and respond at the same time, and a human holds the only switch that does anything.

## What to look at, in order

1. **The demo video** (link in README). Two minutes, one continuous take on live mainnet.
2. **`pnpm proof`** (30 seconds, one API key). Prints measured concurrency: peak inferences in flight, the list of overlapping loops with timestamps, and fails the run if agents ever ran sequentially.
3. **`pnpm serve` then open http://localhost:4400**. Live streams, the sphere, IN FLIGHT and PEAK, the Guardrail cards. Click DRILL MULTI to replay the Raydium pattern (authority change, then a withdrawal) without waiting for a real exploit.
4. **`src/participants/`**. One folder per participant. Each agent is a specification (when to fire) plus a processor (what to run). No orchestrator anywhere.

## Which agents run at the same time

| Participant | Role | Reacts to | Runs concurrently with |
| --- | --- | --- | --- |
| Jupiter Stream, Pumpfun Stream | watchers (human role, no model) | Solana websocket logs | each other, own connections |
| Risk Analyst | agent | every non-heartbeat `chain.event` | itself: one `runLoop` per event, several in flight |
| Correlator | agent | Analyst answers, when 2+ sources in a 120s window | Analyst, Briefer, Responder |
| Briefer | agent | Analyst answers, guardrail decisions, correlations, operator questions | everything, rate-limited to one rewrite per 8s with coalescing |
| Responder | agent | high-severity verdicts | Analyst, Briefer |
| Guardrail | interception handler inside the Responder loop | `execute_action` tool calls | holds one loop, everything else keeps running |
| Operator | human | approves, rejects, asks questions | everything |

Measured on live mainnet: peak of 3 concurrent inferences in a 90s run, peak of 7 in a longer dashboard session, including the Analyst overlapping itself.

## What state they share

One `EnvironmentState` (extends Mozaik `RuntimeState`, see `src/runtime.ts`): incidents, correlations, the rolling brief, operator answers, pending approvals, decisions, executed actions, an append-only event log, an inference budget, and a per-minute Analyst rate limit. Every agent writes its own slice and reads the rest.

## How they coordinate

Only through events and situation handlers:

- Watchers publish custom `chain.event` items via `sendEvent`. Heartbeats are filtered in code and never reach a model.
- The Analyst fires on `chain.event`. Briefer, Correlator, and Responder fire on the Analyst's `model.answer`, filtered by producer id so no agent reacts to its own answer.
- The Guardrail publishes `guardrail.pending` and `guardrail.decision`; the Operator publishes `operator.decision`; the Correlator publishes `correlation.found`. The Briefer reacts to all three.
- The Responder's tool call is gated by a Mozaik `InterceptionHandler`. It waits for the human while every other participant continues.

## Four things that made real concurrency work

1. **Fresh `ModelContext` per loop** (`src/agent-context.ts`). Mozaik's agent memory is one mutable context; two concurrent loops on one agent would read each other's prompts.
2. **`eventId` echo.** `model.answer` carries no loop id, so every event carries an id the model must return in its JSON. Incidents are matched to their trigger by id, never by arrival order.
3. **Budget reservation inside specifications.** A check in the processor would let two simultaneous events both claim the last slot.
4. **Answer routing marker.** Briefs start with `BRIEF:` and question answers with `ANSWER:`, stripped server-side, so concurrent Briefer loops cannot swap outputs.

Every handler is wrapped: one failing handler logs and returns instead of taking the runtime down.

## Calibration

Most incidents are LOW on purpose. Failed-transaction bursts on Jupiter or Pump.fun are congestion, not attacks, and the Analyst is instructed to say so. HIGH is reserved for authority changes paired with fund movement and vault outflows to fresh wallets. The Correlator only links incidents when it can name the shared element (same wallet, privilege change then transfer).

## Honest limits

- Early warning and context, not prevention. Drains finish in blocks.
- `execute_action` is simulated. It records the action; it does not sign anything.
- Model judgement can be wrong. Every verdict carries its reason so a human can disagree.
- Public RPC variance: identical 90s runs have seen 900 and 42,000 logs. A watchdog resubscribes on silence.
- Solana-only watchers today. The watcher interface is chain-agnostic.

## During the build

We found a bug in Mozaik's Anthropic structured-output mapper, filed jigjoy-ai/mozaik#110, and PR #111 was merged into `development` the same day. The tolerant JSON parser in the Analyst exists because the fix is not in the 4.0.0 bundle yet.

## Files worth opening

- `src/runtime.ts` shared state and budget
- `src/participants/analyst/index.ts` per-event loops, eventId correlation
- `src/participants/responder/interception/guardrail.ts` the human gate
- `src/participants/briefer/index.ts` coalescing and answer routing
- `src/report.ts` how peak concurrency and overlaps are measured
- `src/server.ts` WebSocket and HTTP surface for the dashboard
- `MOZAIK-NOTES.md` thirty gotchas learned about Mozaik 4.0.0 during the build
