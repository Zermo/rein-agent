import { NextResponse } from "next/server";

export const runtime = "nodejs";

const SYSTEMONE = "https://api.typesafe.ai/v1/systemone";

function json(status: number, value: unknown) {
  return NextResponse.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export async function POST(request: Request) {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return json(503, { error: "Jev is not configured on this host." });
  let body: unknown;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON." }); }
  const text = typeof body === "object" && body && "text" in body && typeof (body as { text: unknown }).text === "string"
    ? (body as { text: string }).text.trim().slice(0, 500) : "";
  if (!text) return json(400, { error: "Missing text." });
  const payload = {
    model: "jev-latest",
    state: { note: text, surface: "klaudbot field console" },
    questions: {
      pane: {
        type: "choice",
        instructions: "Which pane should the operator open next for this note?",
        criteria: {
          chat: "Stay in the conversation ledger",
          path: "Show the Path spine for tools or steps",
          crt: "Open the CRT / workspace files",
        },
      },
    },
  };
  const response = await fetch(SYSTEMONE, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return json(response.status === 401 ? 503 : 502, { error: "Jev request failed." });
  const result: unknown = await response.json();
  const pane = result && typeof result === "object" && "answers" in result
    ? (result as { answers?: { pane?: { choice?: string; confidence?: number } } }).answers?.pane
    : undefined;
  const choice = pane?.choice === "path" || pane?.choice === "crt" || pane?.choice === "chat" ? pane.choice : "chat";
  const confidence = typeof pane?.confidence === "number" ? pane.confidence : 0;
  return json(200, { pane: choice, confidence, model: "jev" });
}
