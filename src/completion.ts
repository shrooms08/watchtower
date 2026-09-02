/** Bridges a participant's handler back to main.ts, which owns the process lifetime. */
let resolveAnswer!: (answer: string) => void;

export const answered: Promise<string> = new Promise((resolve) => {
	resolveAnswer = resolve;
});

export function notifyAnswer(answer: string): void {
	resolveAnswer(answer);
}
