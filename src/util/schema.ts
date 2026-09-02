/**
 * Tiny JSON-Schema validator for tool arguments (the subset we generate).
 * Supports: type, properties, required, items, enum, minimum/maximum.
 * Returns the validated value or throws with a message a model can act on.
 */
import type { JsonSchema } from "../ai/types.ts";

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

function matches(type: string, value: unknown): boolean {
	const actual = typeOf(value);
	if (type === "number") return actual === "number" || actual === "integer";
	if (type === "integer") return actual === "integer";
	if (type === "array") return actual === "array";
	if (type === "object") return actual === "object";
	if (type === "null") return actual === "null";
	return actual === type;
}

export function validateArgs(schema: JsonSchema | undefined, args: unknown, path = "$"): unknown {
	if (!schema) return args;
	if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(args))) {
		throw new Error(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
	}
	if (schema.type) {
		if (!matches(schema.type, args)) {
			throw new Error(`${path}: expected ${schema.type}, got ${typeOf(args)}`);
		}
	}
	if (typeof args === "number") {
		if (schema.minimum !== undefined && args < schema.minimum) throw new Error(`${path}: must be >= ${schema.minimum}`);
		if (schema.maximum !== undefined && args > schema.maximum) throw new Error(`${path}: must be <= ${schema.maximum}`);
	}
	if (typeOf(args) === "array" && schema.items) {
		for (let i = 0; i < args.length; i++) {
			validateArgs(schema.items, args[i], `${path}[${i}]`);
		}
	}
	if (typeOf(args) === "object" && schema.properties) {
		const obj = args as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in obj)) throw new Error(`${path}: missing required property "${key}"`);
		}
		for (const [key, sub] of Object.entries(schema.properties)) {
			if (key in obj) validateArgs(sub, obj[key], `${path}.${key}`);
		}
	}
	return args;
}
