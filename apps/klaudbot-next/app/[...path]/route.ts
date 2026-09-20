import { proxyRequest } from "../../lib/server-proxy.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// No maxDuration: /run is an unbounded, uncompressed, cancellable SSE stream.
// Root page and actual public/Next assets are served by Next, not the harness.
const handle = (request: Request) => proxyRequest(request);
export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE, handle as HEAD, handle as OPTIONS };