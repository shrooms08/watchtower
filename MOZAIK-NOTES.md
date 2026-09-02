# Mozaik 4.x notes (Watchtower)

Verified against **`@mozaik-ai/core@4.0.0-beta.12`** (pinned exact) on Node 24.14.0 / pnpm 10.33.2,
2026-09-02. Reference: `github.com/jigjoy-ai/mozaik-examples` (cloned to `reference/`, gitignored).

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
