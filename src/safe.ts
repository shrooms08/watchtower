import { SituationContext, SituationProcessor, SituationSpecification } from "@mozaik-ai/core";

/**
 * 4.x runs handlers with no error boundary: EventProcessor.process calls
 * isSatisfiedBy/apply bare, so one throw kills the process mid-publish and the
 * remaining participants never see the event (MOZAIK-NOTES.md gotcha 14).
 * Every handler in this project extends these instead.
 */
function ownerOf(context: SituationContext): string {
	try {
		return context.participant.getManifest().name;
	} catch {
		return "unknown participant";
	}
}

export function logHandlerError(context: SituationContext, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);

	console.error(`[${ownerOf(context)}] handler error: ${message}`);
}

export abstract class SafeSpecification extends SituationSpecification {
	protected abstract evaluate(context: SituationContext): boolean;

	isSatisfiedBy(context: SituationContext): boolean {
		try {
			return this.evaluate(context);
		} catch (error) {
			logHandlerError(context, error);
			return false;
		}
	}
}

export abstract class SafeProcessor implements SituationProcessor {
	protected abstract run(context: SituationContext): void;

	apply(context: SituationContext): void {
		try {
			this.run(context);
		} catch (error) {
			logHandlerError(context, error);
		}
	}
}
