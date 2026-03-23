import { NextRequest, NextResponse } from "next/server";
import { isRovoDevApiError, streamChatHeaders, streamChatRequestUrl, toRouteError } from "@/lib/server/rovodev";
import { withSessionFolder } from "@/lib/server/sessionStore";

const STREAM_CONNECT_TIMEOUT_MS = 15000;

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const yolo = request.nextUrl.searchParams.get("yolo");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    await withSessionFolder(sessionId);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }

  const requestUrl = new URL(streamChatRequestUrl());
  requestUrl.searchParams.set("include_subagent_events", "true");
  // The GUI currently has no manual approval UX for paused tool calls.
  // Always auto-continue tool execution to avoid deadlocks/stuck "Running tool" states.
  // NOTE: `yolo` is still passed through the request URL for future policy use.
  void yolo;
  requestUrl.searchParams.set("pause_on_call_tools_start", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);
  request.signal.addEventListener("abort", () => controller.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(requestUrl.toString(), {
      method: "GET",
      headers: streamChatHeaders(),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const mapped = toRouteError(
      isRovoDevApiError(error)
        ? error
        : new Error(`Unable to connect upstream stream for session ${sessionId}`),
      "STREAM_CONNECT_FAILED",
    );
    return NextResponse.json(mapped.body, { status: mapped.status });
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        ok: false,
        code: "STREAM_UPSTREAM_ERROR",
        error: "Could not stream chat from rovodev server",
        upstreamStatus: upstream.status,
        detail,
      },
      { status: upstream.status >= 400 ? upstream.status : 502 },
    );
  }

  const reader = upstream.body.getReader();
  const proxiedBody = new ReadableStream<Uint8Array>({
    async start(controllerStream) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controllerStream.enqueue(value);
        }
        controllerStream.close();
      } catch (error) {
        controllerStream.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // no-op
      }
    },
  });

  return new NextResponse(proxiedBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
