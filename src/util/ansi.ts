/** Minimal ANSI helpers. No dependencies, respects NO_COLOR and non-TTY. */

const enabled = process.stdout.isTTY && !("NO_COLOR" in process.env);

function wrap(open: number, close: number): (text: string) => string {
	return (text: string) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
