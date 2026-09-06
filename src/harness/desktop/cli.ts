import { desktopAvailable, nativeApp, openNodeTerm, preferSurface, preferredSurface, registerRein } from "./surface.ts";

export async function desktopCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
	const action = args[0] ?? "status";
	if (action === "use" && args.length === 2 && ["terminal", "nodeterm"].includes(args[1])) {
		preferSurface(args[1] as "terminal" | "nodeterm"); console.log(`Rein's preferred surface is ${args[1]}.`); return;
	}
	if (args.length > 1 || !["install", "open", "status"].includes(action)) throw new Error("Usage: rein desktop install [--no-launch] | open | status | use terminal|nodeterm");
	if (action === "status") { console.log(`Preferred surface: ${preferredSurface()}\nNodeTerm: ${nativeApp() ? "installed" : "not found"}`); return; }
	if (action === "install") {
		if (flags["if-supported"] === true && preferredSurface() === "terminal") {
			console.log("Keeping Rein's saved terminal preference. Run rein desktop install to switch to NodeTerm."); return;
		}
		if (flags["if-supported"] === true && !desktopAvailable()) {
			console.log("Native desktop setup skipped on this platform or remote/CI shell. Rein remains available in this terminal."); return;
		}
		const { installNodeTerm } = await import("./install.ts");
		const result = await installNodeTerm({ launch: false });
		console.log(result.detail);
		if (!result.installed) { process.exitCode = 1; return; }
		console.log(await registerRein());
		preferSurface("nodeterm");
		if (flags["no-launch"] === true) return;
	}
	await openNodeTerm();
	console.log("NodeTerm is open. Choose a project and add a Rein agent node. In an existing terminal node, run rein --terminal.");
	console.log("NodeTerm currently cannot accept a project or session command from an external CLI; session flags stay in the terminal where you run them.");
}
