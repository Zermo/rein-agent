#!/usr/bin/env node
// Dev entry point: runs the TypeScript directly (Node >= 23.6 strips types
// natively — but only outside node_modules, which is why the published bin
// is the plain-JS bundle dist/rein.js built from this file).
import { main } from "../src/cli.ts";

main(process.argv.slice(2)).catch((err) => {
	console.error(err?.stack ?? String(err));
	process.exit(1);
});
