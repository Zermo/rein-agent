import { NextResponse } from "next/server";
import { BOT_ID, loadHarnessUnit, saveHarnessUnit } from "../../../lib/unit-harness.ts";
import { normalizeUnit } from "../../../lib/unit-profile.ts";

export const runtime = "nodejs";

function json(status: number, value: unknown) {
  return NextResponse.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function botIdOf(request: Request, body?: unknown): string {
  const url = new URL(request.url);
  const query = url.searchParams.get("botId") ?? "";
  const fromBody = body && typeof body === "object" && "botId" in body && typeof (body as { botId: unknown }).botId === "string"
    ? (body as { botId: string }).botId : "";
  const id = (fromBody || query).trim();
  if (!BOT_ID.test(id)) throw new Error("Invalid unit.");
  return id;
}

export async function GET(request: Request) {
  try {
    const id = botIdOf(request);
    const unit = loadHarnessUnit(id);
    if (!unit) return json(404, { error: "Unknown field unit." });
    return json(200, unit);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid unit." });
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON." }); }
  try {
    const id = botIdOf(request, body);
    const raw = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const saved = saveHarnessUnit(id, normalizeUnit({ soul: raw.soul, directive: raw.directive, routines: raw.routines }));
    return json(200, { soul: saved.soul, directive: saved.directive, routines: saved.routines });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save unit.";
    return json(message === "Unknown field unit." ? 404 : 400, { error: message });
  }
}
