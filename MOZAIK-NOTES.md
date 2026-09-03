# Mozaik 4.x notes (Watchtower)

Verified against **`@mozaik-ai/core@4.0.0`** (pinned exact) on Node 24.14.0 / pnpm 10.33.2,
2026-09-03. Reference: `github.com/jigjoy-ai/mozaik-examples` (cloned to `reference/`, gitignored).

**Upgraded from `4.0.0-beta.12` on 2026-09-03. `dist/index.mjs` is byte-identical between the two**
(`diff` returns 0), so the stable release changes no runtime behaviour whatsoever: same event type
strings, same transition shapes, same mappers, same bugs. The only difference is in `index.d.ts`:

- **`ExecutableTransition` is now exported** as `type ExecutableTransition = LoopTransition<ExecutableLoopStateId>`,
  and `InterceptionHandler` is declared in terms of it. Every example (and this project) previously
  declared that alias locally; `src/participants/responder/interception/guardrail.ts` now imports it.

That is the entire delta. **Every gotcha below still applies in 4.0.0** — none was fixed, because no
runtime code changed. Re-verified explicitly after the upgrade: `ParticipantManifest` is still not
exported (gotcha 1), `EventProcessor.process` still has no try/catch (gotcha 14), and the Anthropic
`structuredOutput` mapper still sends `json_schema` (gotcha 17 / upstream issue #110, still open).

**The docs site (docs.jigjoy.ai) describes 3.x and does not apply.** 4.x shares almost no API with
it: there is no `AgenticEnvironment`, no `BaseParticipant`, no `runInference`/`sendMessage`
capability functions, and no `onMessage`/`onExternal*` handler methods. The examples repo is the
source of truth.

## Project layout (mirrors the examples)

```
src/runtime.ts                                  defineRuntime + shared state
src/completion.ts                               deferred promise back to main
src/main.ts                                     initializeRuntime, join, sendMessage, sendEvent
src/participants/<name>/index.ts                createHuman / createAgent
src/participants/<name>/situations/<event>.ts   one SituationHandler per situation
src/participants/<name>/tools.ts                Tool definitions (when the agent has tools)
src/participants/<name>/interception/<x>.ts     InterceptionHandler (when intercepting)
```

## Exact imports that worked

```ts
// src/runtime.ts
import { defineRuntime, RuntimeState } from "@mozaik-ai/core";

// participants
import { createAgent, createHuman } from "@mozaik-ai/core";
import {
  Agent,
  FunctionCallItem,
  FunctionCallOutputItem,
  InferenceInput,
  InferenceOutput,
  ModelMessageItem,
  SemanticEvent,
  SituationContext,
  SituationHandler,
  SituationProcessor,
  SituationSpecification,
  Tool,
} from "@mozaik-ai/core";

// interception
import type {
  ExecutableLoopStateId,
  InterceptionHandler,
  LoopTransition,
} from "@mozaik-ai/core";

// main.ts - dotenv FIRST, before anything that touches the package
import "dotenv/config";
```

Everything is a named export from the package root. **Runtime helpers are never imported from the
package** — `join`, `sendMessage`, `sendEvent`, `runLoop`, `resolveRuntime`, `resolveParticipant`
come from your own `src/runtime.ts`.

## `defineRuntime` exports

```ts
export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
  defineRuntime<EnvironmentState>();
```

`defineRuntime<T>()` closes over one module-level runtime instance; call it **once** and re-export.

| Export | Signature | What it does |
| --- | --- | --- |
| `initializeRuntime` | `({ state, inferenceRunnerConfig? }) => RuntimeService<T>` | Creates the single runtime. **Throws `Runtime already initialized` if called twice.** `inferenceRunnerConfig` can override `supportedModels` or swap the whole `runner`. |
| `resolveRuntime` | `() => RuntimeService<T>` | The live runtime; `resolveRuntime().state` is your shared state. Throws if not initialized. |
| `resolveParticipant` | `(id: string) => Participant` | Look a participant up by id — the way to turn `event.producerId` into a name. **Throws** for unknown ids. |
| `join` | `(participant) => void` | Adds the participant, then publishes `participant.joined`. |
| `leave` | `(participant) => void` | Removes the participant, then publishes `participant.left`. |
| `sendMessage` | `(message: string, senderId: string) => void` | Publishes `message.sent` with `{ message }`, producer = `senderId`. |
| `sendEvent` | `(event: SemanticEvent, senderId: string) => void` | Publishes any event, custom types included. |
| `runLoop` | `(agentId, message, inferenceInput, interceptionHandler?) => void` | Starts the agent loop. Returns `void`, fire-and-forget. |

`RuntimeService.publish` fans an event out to **every** participant **including the producer** —
there is no self/external split as in 3.x. A handler that must ignore its own output filters
explicitly: `context.event.producerId === context.participant.getId()`.

## The SituationHandler pattern

A handler is a **specification** (when does this apply?) plus a **processor** (what do I do?):

```ts
export class ModelAnswerSpecification extends SituationSpecification {
  isSatisfiedBy(context: SituationContext): boolean {
    return context.event.type === "model.answer";
  }
}

export class ModelAnswerRenderer implements SituationProcessor {
  apply(context: SituationContext): void {
    const { answer } = context.event.payload as { answer: ModelMessageItem };
    console.log("answer:", answer.content.text);
  }
}

export const modelAnswerHandler: SituationHandler = {
  specification: new ModelAnswerSpecification(),
  processor: new ModelAnswerRenderer(),
};
```

`SituationContext` is `{ event: SemanticEvent, participant: Participant }` — `participant` is
**the participant being asked**, not the producer. Cast it (`context.participant as Agent`) to reach
`getMemory()` / `getTools()`.

`SituationSpecification` is an abstract class (extend it) with combinators: `.and(other)`,
`.or(other)`, `.not()`. `SituationProcessor` is an interface (implement it) and `apply` may return
`void | Promise<void>` — the runtime does **not** await it.

A catch-all observer is just `isSatisfiedBy() { return true }`; that is what
`src/participants/observer/situations/all-events.ts` uses, and it picks up custom events too.

`SemanticEvent` is `{ type, producerId, occurredAt: Date, payload }`.

## Event types and payload shapes

Full list, from `EventPublisherLoopVisitor` + `ParticipantJoined/LeftEvent` + `MessageSentEvent` in
`node_modules/@mozaik-ai/core/dist/index.mjs`:

| Event type | Payload |
| --- | --- |
| `participant.joined` | `ParticipantManifest` — `{ id, name, role: "agent" \| "human", capabilities? }` |
| `participant.left` | `ParticipantManifest` |
| `message.sent` | `{ message: string }` |
| `context_update.started` | `{ content: string, input: InferenceInput, loopId: string }` |
| `context_update.completed` | `InferenceInput` spread + `{ loopId }` — i.e. `{ model, context, tools, …, loopId }` |
| `inference.started` | `InferenceInput` |
| `inference.stream` | the **raw provider chunk** (provider-specific), plus one final `{ type: "inference.output", payload }`. Streaming runs only. |
| `inference.completed` | `InferenceOutput` — `{ items: InferenceItem[], tokenUsage?: TokenUsage, rowResponse }` (`rowResponse`, not `rawResponse`) |
| `function_call.started` | `{ call: FunctionCallItem, inferenceInput: InferenceInput }` |
| `function_call.completed` | a bare `FunctionCallOutputItem` — read `payload.output.text` |
| `model.answer` | `{ answer: ModelMessageItem }` — read `answer.content.text` |
| `interception.started` | the pending `LoopTransition` — `{ nextStateId, input }` |
| `interception.finished` | the resolved `LoopTransition` |

Observed live in this smoke test: `participant.joined`, `message.sent`, `context_update.started`,
`context_update.completed`, `inference.started`, `inference.completed`, `model.answer`, and our
custom `chain.event`. The rest are read from the source and the examples — `inference.stream` needs
`streaming: true`, the `function_call.*` pair needs an agent with tools, and `interception.*` needs
an `InterceptionHandler`.

## Custom events

Create with `SemanticEvent.create(type, producerId, payload)` and publish with `sendEvent`:

```ts
sendEvent(SemanticEvent.create("chain.event", user.getId(), { step: 1 }), user.getId());
```

React to it like any other event:

```ts
class ChainEventSpecification extends SituationSpecification {
  isSatisfiedBy(context: SituationContext): boolean {
    return context.event.type === "chain.event";
  }
}
```

**`sendEvent`'s `senderId` only authorizes the call** — it is checked against the participant list
and then ignored. The `producerId` that reaches handlers is the one baked into the event by
`SemanticEvent.create`. Pass the same id to both or `resolveParticipant(producerId)` will disagree
with who you think sent it. Verified working: `#10 chain.event (custom) <- Operator`.

## Shared state via `RuntimeState`

Subclass `RuntimeState` (it holds the participant map: `addParticipant`, `removeParticipant`,
`getParticipant`, `getParticipants`), hand an instance to `initializeRuntime`, and reach it from
anywhere — handlers, tools, helpers — with `resolveRuntime().state`:

```ts
export class EnvironmentState extends RuntimeState {
  constructor(public readonly events: EventCounter) {
    super();
  }
}

initializeRuntime({ state: new EnvironmentState(new EventCounter()) });

// anywhere
resolveRuntime().state.events.record(event.type);
```

It is a plain mutable object — no reducers, no immutability, no locking. `history-simulation` uses
it for turn limits (`canStartTurn` / `startTurn` / `endTurn`), `human-in-the-loop` uses it as a
ledger a tool writes into and another agent drains.

## `runLoop` and `InferenceInput`

```ts
runLoop(agent.getId(), message, inferenceInput, interceptionHandler?);

type InferenceInput = {
  model: string;              // NOT a union in 4.x - unknown names fail at runtime, not compile time
  context: ModelContext;      // agent.getMemory().getContext()
  tools?: Tool[];             // agent.getTools()
  maxOutputTokens?: number;
  reasoningEffort?: string;
  streaming?: boolean;
  structuredOutput?: StructuredOutputFormat;
};
```

The loop is a state machine: `context_update → inference | inference_streaming → function_call →
inference → … → model_message → idle`. Each state publishes its `*.started` / `*.completed` events.

## `InterceptionHandler`

Pass as `runLoop`'s 4th argument. It can approve, rewrite, or redirect a pending transition:

```ts
type ExecutableTransition = LoopTransition<ExecutableLoopStateId>; // stateIds minus "idle"

export class ApprovalInterceptionHandler implements InterceptionHandler {
  isSatisfiedBy(transition: ExecutableTransition): boolean {
    return transition.nextStateId === "function_call";
  }

  async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
    return transition;                                   // continue unchanged
    // or redirect:
    // return { nextStateId: "inference", input: inferenceInput };
    // or loop back with a correction:
    // return { nextStateId: "context_update", input: { content: "...", input: inferenceInput } };
  }
}
```

`nextStateId` is one of `context_update | inference | inference_streaming | function_call |
model_message`, and `input` must match `LoopStateContract[nextStateId]["input"]`:
`context_update` → `{ content, input }`, `inference`/`inference_streaming` → `InferenceInput`,
`function_call` → `{ call, inferenceInput }`, `model_message` → `{ answer }`.
`handle` is `async`, so this is where a real human prompt goes (`human-in-the-loop` blocks on
`readline/promises`).

## Tool definition

```ts
export const getStockQuote: Tool = {
  type: "function",
  name: "get_stock_quote",
  description: "Look up the latest quote for a ticker.",
  strict: false,
  parameters: {                       // plain JSON Schema
    type: "object",
    properties: { ticker: { type: "string", description: "e.g. AAPL" } },
    required: ["ticker"],
    additionalProperties: false,
  },
  invoke: async ({ ticker }: { ticker: string }) => ({ ticker, price: 227.52 }),
};
```

Attach with `createAgent({ tools: [...] })` and pass `agent.getTools()` into `InferenceInput`.
The loop resolves the call by **name** against `inferenceInput.tools` and runs `invoke` itself —
unlike 3.x there is no manual `executeFunctionCall`. An unmatched name yields
`Error: unknown tool "<name>"` as the function output instead of throwing.
A tool reaches shared state through `resolveRuntime().state`.

## Models

`InferenceInput.model` is a plain `string` in 4.x — **no compile-time checking**. Names are resolved
at runtime against `supportedModels` (exported), each entry pairing an endpoint with a spec.
Anthropic **is** supported: `AnthropicMessages` on `@anthropic-ai/sdk`, client constructed lazily
from `ANTHROPIC_API_KEY`.

Accepted Anthropic names:

```
claude-haiku-4-5     <- used by Watchtower (only Haiku, i.e. cheapest)
claude-sonnet-4-6
claude-opus-4-7
claude-opus-4-8
```

Also registered: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5` (OpenAI Responses),
`gemini-3.5-flash`, `gemini-3.1-pro-preview`, `deepseek-v4-flash`, `deepseek-v4-pro`.
Every example in the repo uses `gpt-5.4`; swapping in `claude-haiku-4-5` needed no other change.

## Concurrency (measured, not assumed)

**`runLoop` does not serialise — not globally, and not per participant.** Verified by
`pnpm proof`: peak 3 inferences in flight at once, with the Risk Analyst overlapping *itself*
(`Risk Analyst started …12.802Z while Risk Analyst was in flight (started …12.621Z, completed
…15.468Z)`). Each `runLoop` call builds its own `AgentLoop`, `LoopStateExecutor` and
`TransitionResolver`, then calls `agentLoop.run(...)` **without awaiting** — nothing keyed on the
agent id gates it. One agent can therefore have any number of loops open at once.

What that buys and what it costs:

- **Fan-out is free.** N events arriving together start N loops; no queue, no worker pool. The
  budget cap has to be yours (`InferenceBudget.tryConsume()` in the specification, so the
  reservation happens at the moment of the decision).
- **`agent.getMemory().getContext()` is a single mutable object shared by every loop.**
  `ModelContext.addContextItems` / `addItem` **push into the existing array and return `this`** —
  they do not copy. Two concurrent loops on one agent append into the same context and each
  inference sees the other's prompt. The examples all pass agent memory because they run one loop
  at a time. Watchtower gives each loop a fresh context instead (`src/agent-context.ts`):

  ```ts
  const context = ModelContext.create();
  context.addItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));
  ```

  `Agent.create` seeds memory with a `DeveloperMessageItem` built from `instruction`, so rebuilding
  it this way reproduces the agent's system prompt exactly, with no cross-talk. Use shared memory
  only when you want a genuinely accumulating conversation *and* loops never overlap.
- **Answers cannot be correlated back to their trigger.** `context_update.*` carries `loopId`;
  `inference.started`, `inference.completed` and `model.answer` **do not**. With concurrent loops on
  one agent there is no supported way to tell which `model.answer` belongs to which event. Watchtower
  matches in dispatch order (a FIFO of pending analyses), which is approximate and visibly mislabels
  a chain when two answers land out of order. **If exact correlation matters, carry a correlation id
  inside the prompt and have the model echo it, or give each concurrent job its own participant.**
- Pairing `inference.started` with `inference.completed` for a duration has the same limitation —
  `src/report.ts` pairs per producer in arrival order. Peak concurrency itself is exact, because
  sweeping +1/-1 over the log needs no pairing.

## Structured output is broken for Anthropic in 4.x

`structuredOutput` (the `reference/mozaik-examples/structured-output` pattern) **cannot be used with
`claude-haiku-4-5`**. `AnthropicMessagesMapper.toRequest` builds

```js
outputConfig.format = { type: "json_schema", json_schema: inferenceInput.structuredOutput.schema }
```

and the API rejects it outright:

```
400 invalid_request_error
output_config.format: Unexpected key 'json_schema'. The expected format is {"type": "json_schema", "schema": {...}}
```

The feature exists on the Anthropic side; the mapper just names the field `json_schema` where the API
wants `schema` — a one-word upstream fix, but it is a hard 400 today and, because `runLoop` never
awaits, it arrives as an unhandled rejection rather than an error event. Reported upstream as
[jigjoy-ai/mozaik#110](https://github.com/jigjoy-ai/mozaik/issues/110); **still present and
unchanged in 4.0.0**, re-checked against the released bundle. The OpenAI path is
unaffected, which is why every example that uses `structuredOutput` runs `gpt-5.4`.

**Workaround in use:** ask for JSON in the prompt and parse tolerantly (`parseVerdict` in
`src/chain-event.ts` — tries the raw text, then a ```json fence, then the outermost `{...}`, and
validates the shape before trusting it). Across live and simulated runs Haiku returned clean JSON
every time (0 parse failures), but the tolerant path stays because a single malformed answer would
otherwise poison an incident record.

## Model switching

`InferenceInput.model` is a plain string resolved at runtime against `supportedModels`, so every
agent can run a different model. Watchtower reads three env vars in `src/models.ts`, each defaulting
to `claude-haiku-4-5`: `MODEL_ANALYST`, `MODEL_BRIEFER`, `MODEL_RESPONDER` (see `.env.example`).

The full set 4.0.0 registers:

| Provider | Model names | Credential |
| --- | --- | --- |
| Anthropic | `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5` | `OPENAI_API_KEY` |
| Gemini | **`gemini-3.5-flash`**, **`gemini-3.1-pro-preview`** | `GEMINI_API_KEY` |
| DeepSeek | `deepseek-v4-flash`, `deepseek-v4-pro` | `OPENAI_API_KEY` + `OPENAI_BASE_URL` |

**Gemini needs `GEMINI_API_KEY` in `.env`** — `GeminiGenerateContent` reads it directly
(`process.env.GEMINI_API_KEY`), and no key is configured in this repo. Nothing else changes: point
`MODEL_ANALYST=gemini-3.5-flash` and the runtime picks the Gemini endpoint on its own. Worth knowing
before switching: `structuredOutput` works on the Gemini path (`responseMimeType` +
`responseSchema`), unlike Anthropic — see the section above.

## Gotchas

1. **`ParticipantManifest` is declared but not exported.** `import { ParticipantManifest }` fails
   with `TS2459`. Mirror the shape locally (`{ id, name, role, capabilities? }`) — this was the one
   compile error in the build.
2. **`resolveParticipant` throws on `participant.left`.** `leave()` removes the participant *before*
   publishing, so resolving `event.producerId` for that event throws `Participant <id> not found`.
   Wrap it, and fall back to the manifest in the payload (which `participant.*` events carry).
3. **Join order decides what an observer sees.** `join()` publishes `participant.joined` only to
   participants already joined, so an observer that joins last never sees the others arrive. Join
   observers **first**.
4. **Producers receive their own events.** No self/external split. `model.answer` reaches the
   emitting agent too — filter on `producerId === participant.getId()` (that is exactly how
   `history-simulation` separates "my answer" from "someone else's answer").
5. **`runLoop` returns `void` and awaits nothing.** A provider failure becomes an unhandled promise
   rejection that kills the process rather than an event. Keep
   `process.on("unhandledRejection", …)` in `main.ts`.
6. **`sendEvent`'s `senderId` is not the producer** — see the custom-events section above.
7. **`initializeRuntime` throws if called twice**, and every other export throws
   `Runtime not initialized` before it is called. `main.ts` must initialize before anything else runs.
8. **`inference.stream` never fires without `streaming: true`** — the non-streaming path calls
   `runner.run()`, not `runner.stream()`, so only `inference.started` / `inference.completed` appear.
9. **`function_call.completed`'s payload is a bare `FunctionCallOutputItem`**, even though
   `LoopStateContract["function_call"]["output"]` types it as `{ item }`. Trust the examples
   (`payload as FunctionCallOutputItem`), not the contract type.
10. **`InferenceOutput.rowResponse`** is spelled that way (not `rawResponse`).
11. **`import "dotenv/config"` must be the first import in `main.ts`.** ESM evaluates imports in
    order, and the provider client reads `process.env` when it is first constructed.
12. **Harmless startup line on stdout:** `mozaik cloud: no API key (MOZAIK_API_KEY) — telemetry
    disabled, events will not be sent`. Set `MOZAIK_API_KEY` only if you want cloud telemetry.
13. **The model name is not type-checked** (gotcha inherited from `model: string`). A typo surfaces
    only at runtime, inside the un-awaited loop — i.e. as gotcha 5.
14. **Nothing catches exceptions thrown inside a handler.** `EventProcessor.process` calls
    `specification.isSatisfiedBy` and `processor.apply` with no try/catch, and `RuntimeService.publish`
    adds none, so one bad handler kills the process mid-publish and the remaining participants never
    see the event. 3.x wrapped delivery in a try/catch; 4.x does not. A `chain.event` whose payload
    was not the shape the observer assumed took the whole run down this way — **validate custom event
    payloads before reading them**, since `sendEvent` accepts any shape under any type name.
15. **`ModelContext.addContextItems` mutates and returns `this`** — see the concurrency section. It
    reads like a copy-on-write builder and is not one.
16. **A specification can be side-effecting, and sometimes must be.** Handlers run in array order for
    a participant, and the specification is the only place that sees a candidate event before the
    decision is final — that is where a budget reservation belongs, otherwise two events arriving
    together both pass a `hasCapacity()` check and both start loops.
17. **`structuredOutput` + Anthropic = hard 400** — see the section above. Prompt for JSON instead.
18. **Correlate by an id you put in the prompt.** Since `model.answer` carries no loop id, the only
    reliable correlation is to embed a short `eventId` in the prompt, require the model to echo it,
    and index by it (`state.analysedEvents`). This replaced the FIFO guess and made every incident in
    both the live and simulated runs correctly attributed (`correlated=true`).
19. **web3.js v1 keeps its websocket private.** `Connection` exposes no `error`/`close` events, so
    reconnect logic has to hook `(connection as any)._rpcWebSocket` (guarded - it may not be there)
    **and** run a staleness watchdog, since a socket that dies quietly produces no event at all.
20. **A callback handed to `connection.onLogs` must never throw** — it runs inside web3.js's socket
    dispatch, outside any handler of ours, so `SafeProcessor` does not cover it. Wrap the body.
21. **The public mainnet RPC held up fine** at 1 sampled `getParsedTransaction` per 3s: two 90s runs
    against Jupiter v6, ~4,000-4,500 logs each, 29 samples, **zero 429s and zero reconnects**. The
    *websocket* is less reliable than the RPC: a later two-stream run saw both sockets go silent
    mid-run and the staleness watchdog resubscribe each once (930 logs instead of ~42,000, still
    zero 429s and zero RPC errors). Log volume from the public endpoint is not something to treat
    as a stable number. The
    websocket firehose is free; only the sampled RPC fetches are rate-limit exposed, so the 1-in-flight
    + 3s spacing guard is what keeps it safe. Do not raise the sample rate without a paid endpoint.
22. **`removeOnLogsListener` can block for over a minute.** It waits for an unsubscribe ack over the
    same websocket the firehose is saturating; stopping two streams (~19k queued messages) turned a
    90s run into 159s, all of it after the last event. Race it against a timeout - Watchtower caps it
    at 3s (`unsubscribeTimeoutMs`) and abandons the ack, which brought the same run back to 93s.
23. **One `Connection` per stream, always.** Two `onLogs` subscriptions on a shared `Connection`
    share a websocket, a reconnect state and a message queue, so a flood on one program stalls the
    other. Each `createSolanaWatcher` builds its own `Connection`, failure window, suppression clock,
    sampling clock and counters; only the runtime and `EnvironmentState` are shared.
24. **Two live streams put real concurrency in the live run.** Independent programs emit detections
    at unrelated times, so analyst loops overlap each other and the briefer without any simulation:
    peak 3 and peak 2 across two runs, versus a flat 1 with a single stream (whose 30s failed-burst
    suppression spaced every event beyond an inference).
25. **Volume differs wildly by program and does not track usefulness.** Pump.fun delivered 16,900
    logs in 90s (14,179 failed) against Jupiter's 2,423 - but because sampling is time-based, both
    streams fetched ~20 transactions either way. The rate guard is what keeps a firehose from
    turning into RPC load.
26. **`InterceptionHandler` transition shapes matched the notes exactly** — no adjustment needed.
    `isSatisfiedBy` sees `{ nextStateId: "function_call", input: { call, inferenceInput } }`, returning
    the transition untouched lets the tool run, and the rejection path is
    `inferenceInput.context.addContextItems([call, output])` then
    `{ nextStateId: "inference", input: inferenceInput }`, exactly as `human-in-the-loop` does it.
    The model then answers normally, so the rejection reads to it as a tool result rather than an error.
27. **Interception is where a guardrail belongs, not the tool.** `invoke()` runs only after `handle()`
    returns an unmodified `function_call` transition, so a rejected action never reaches the tool at
    all — the auto-reject drill records 0 executed actions while the approve drill records 1. A check
    inside `invoke()` would already be too late to be called a gate.
28. **An interceptor needs a participant to speak as.** `handle()` runs inside the agent's loop, not
    in a handler, so `context.participant` is not available: import the Guardrail participant and pass
    its id to `SemanticEvent.create` / `sendEvent`, otherwise the events would be attributed to whoever
    happens to be convenient.
29. **`handle()` is genuinely async and blocks only its own loop.** A 3s auto-reject wait holds that
    responder loop open while every other participant keeps producing — the guardrail never stalls the
    runtime, which is the same non-serialising behaviour as `runLoop` itself.

## Gemini and function calling

`GeminiGenerateContent`'s mapper **drops thought signatures entirely** — checked in the 4.0.0 bundle,
which contains no `thoughtSignature` / `thought_signature` string at all. Outbound it writes
`functionCall: { id, name, args }`; inbound it rebuilds items with
`FunctionCallItem.rehydrate({ callId, name, args })`, whose shape has nowhere to put a signature. So a
signature returned by a thinking model is neither stored nor echoed back on the next turn.

This only matters if you point `MODEL_ANALYST` / `MODEL_RESPONDER` at a `gemini-*` model **and** the
agent has tools: Google expects thought signatures returned with the function call they belong to, and
this mapper cannot do that. Watchtower runs Anthropic everywhere, so it is unaffected today — but the
Responder is the tool-using agent, and switching it to Gemini is the case to be careful about.
