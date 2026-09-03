#!/usr/bin/env node
// Entry point. Node >= 23.6 strips types from the .ts modules below natively.
import { main } from "../src/cli.ts";

main(process.argv.slice(2)).catch((err) => {
	console.error(err?.stack ?? String(err));
	process.exit(1);
});
