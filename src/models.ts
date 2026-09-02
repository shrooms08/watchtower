/**
 * Per-agent model selection. Every name must be one 4.x registers in
 * `supportedModels` - `InferenceInput.model` is a plain string, so a typo only
 * fails at runtime, inside an un-awaited loop (MOZAIK-NOTES.md gotcha 13).
 */
const DEFAULT_MODEL = "claude-haiku-4-5";

export const MODEL_ANALYST = process.env.MODEL_ANALYST ?? DEFAULT_MODEL;
export const MODEL_BRIEFER = process.env.MODEL_BRIEFER ?? DEFAULT_MODEL;
export const MODEL_RESPONDER = process.env.MODEL_RESPONDER ?? DEFAULT_MODEL;

export function modelSummary(): string {
	return `analyst=${MODEL_ANALYST} briefer=${MODEL_BRIEFER} responder=${MODEL_RESPONDER}`;
}
