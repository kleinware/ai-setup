// GET /api/events — server-sent events stream. Sends an "update" event
// shortly after any file in spec/ changes; clients refetch /api/specs.

import { onStoreUpdate } from "@/lib/watcher";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = onStoreUpdate(() => {
        try {
          controller.enqueue(encoder.encode('data: {"type":"update"}\n\n'));
        } catch {
          // stream already closed
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
