import { NextResponse } from "next/server";
import { getProxyConfig, validateRequestBoundary } from "./lib/server-proxy.ts";

export function middleware(request: Request) {
  try {
    return validateRequestBoundary(request, getProxyConfig()) ?? NextResponse.next();
  } catch {
    return Response.json({ error: "Invalid proxy configuration." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

// No asset exclusions: static content is unauthenticated, not Host-unchecked.
export const config = { matcher: "/:path*", runtime: "nodejs" };