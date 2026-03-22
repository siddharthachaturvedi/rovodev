import { NextRequest, NextResponse } from "next/server";
import { streamChatHeaders, streamChatRequestUrl } from "@/lib/server/rovodev";
import { withSessionFolder } from "@/lib/server/sessionStore";

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
  // yolo=true means auto-approve all tool calls; otherwise pause and require approval
  // For now we default to auto-approve since the GUI has no manual approval UI yet
  const autoApprove = yolo !== "false";
  requestUrl.searchParams.set("pause_on_call_tools_start", autoApprove ? "false" : "true");
  const upstream = await fetch(requestUrl.toString(), {
    method: "GET",
    headers: streamChatHeaders(),
    cache: "no-store"
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Could not stream chat from rovodev server" }, { status: 502 });
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
