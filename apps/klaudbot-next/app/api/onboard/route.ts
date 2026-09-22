import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid" }, { status: 400 }); }
  if (!body || typeof body !== "object") return Response.json({ error: "invalid" }, { status: 400 });
  const email = String((body as { email?: unknown }).email ?? "").trim().toLowerCase();
  const name = String((body as { name?: unknown }).name ?? "").trim().slice(0, 80);
  if (!EMAIL.test(email) || email.length > 120 || !name) return Response.json({ error: "invalid" }, { status: 400 });
  const dir = join(homedir(), ".rein", "klaud");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: new Date().toISOString(), email, name, status: "pending" }) + "\n";
  await appendFile(join(dir, "onboard-pending.jsonl"), line, { mode: 0o600 });
  return Response.json({ ok: true, queued: true });
}
