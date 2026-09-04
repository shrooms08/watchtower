import { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core";
import { isolatedInput } from "../../../agent-context";
import {
	CORRELATION_WINDOW_MS,
	CORRELATOR_MIN_INTERVAL_MS,
	distinctSources,
	windowKey,
} from "../../../correlation";
import { MODEL_CORRELATOR } from "../../../models";
import { resolveRuntime, runLoop } from "../../../runtime";
import { SafeProcessor, SafeSpecification } from "../../../safe";

/**
 * Fires when the analyst has just answered and the recent window holds
 * incidents from more than one stream. Every gate is checked before the budget
 * is touched, and the window is marked seen at the moment it is claimed, so a
 * second answer arriving during the loop cannot re-send the same set.
 */
export class CrossStreamSpecification extends SafeSpecification {
	protected evaluate(context: SituationContext): boolean {
		if (context.event.type !== "model.answer") {
			return false;
		}

		const state = resolveRuntime().state;

		// Never its own answers, and only the analyst's.
		if (context.event.producerId !== state.analystId) {
			return false;
		}

		const window = state.incidentsInWindow(CORRELATION_WINDOW_MS);

		if (distinctSources(window).length < 2) {
			return false;
		}

		const key = windowKey(window);

		if (state.correlatorSeen.has(key)) {
			return false;
		}

		const sinceLast = Date.now() - state.correlatorLastRunTs;

		if (sinceLast < CORRELATOR_MIN_INTERVAL_MS) {
			return false;
		}

		const budget = state.inferenceBudget;

		if (!budget.tryConsume()) {
			console.log(`[correlator] budget exhausted (${budget.used}/${budget.max}) - window not evaluated`);
			return false;
		}

		state.correlatorSeen.add(key);
		state.correlatorLastRunTs = Date.now();
		return true;
	}
}

export class CorrelateProcessor extends SafeProcessor {
	protected run(context: SituationContext): void {
		const agent = context.participant as Agent;
		const state = resolveRuntime().state;
		const window = state.incidentsInWindow(CORRELATION_WINDOW_MS);

		const payload = window.map((incident) => {
			const event = state.analysedEvents.get(incident.eventId);

			return {
				id: incident.id,
				source: incident.source,
				kind: incident.kind,
				wallet: event?.wallet ?? "unknown",
				amountSol: event?.amountSol,
				amountUsd: event?.amountUsd ?? 0,
				ts: new Date(incident.ts).toISOString(),
				reason: incident.summary,
			};
		});

		console.log(`[correlator] evaluating ${payload.length} incidents across ${distinctSources(window).length} streams`);

		runLoop(agent.getId(), `Incidents: ${JSON.stringify(payload)}`, isolatedInput(agent, MODEL_CORRELATOR, 320));
	}
}

export const crossStreamHandler: SituationHandler = {
	specification: new CrossStreamSpecification(),
	processor: new CorrelateProcessor(),
};
