import { NextRequest, NextResponse } from "next/server";
import { cancelChat, currentSessionId, restoreSession, setChatMessage } from "@/lib/server/rovodev";
import { withSessionFolder } from "@/lib/server/sessionStore";

type Payload = {
  sessionId?: string;
  message?: string;
  enableDeepPlan?: boolean;
  yoloMode?: boolean;
  model?: string;
  clientMessageId?: string;
  streamCorrelationId?: string;
};

type ChatRouteResponse =
  | {
      ok: true;
      folderPath: string;
      sync: {
        sessionId: string;
        clientMessageId: string;
        streamCorrelationId: string;
      };
    }
  | {
      ok: false;
      error: string;
      code: "BAD_REQUEST" | "NO_SESSION_FOLDER" | "CHAT_PREP_FAILED";
    };

function buildMessage(payload: Required<Pick<Payload, "message" | "yoloMode" | "model">>, folderPath: string): string {
  const header = [
    `Session folder policy (hard): ${folderPath}`,
    "Only read/write files in this session folder unless the user explicitly changes policy.",
    `Preferred model hint: ${payload.model}`,
    `YOLO mode requested by user: ${payload.yoloMode ? "on" : "off"}`
  ].join("\n");
  return `${header}\n\nUser request:\n${payload.message}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Payload;
    if (!body.sessionId || !body.message) {
      const response: ChatRouteResponse = {
        ok: false,
        error: "sessionId and message are required",
        code: "BAD_REQUEST",
      };
      return NextResponse.json(response, { status: 400 });
    }
    const clientMessageId = body.clientMessageId ?? `msg-${Date.now()}`;
    const streamCorrelationId = body.streamCorrelationId ?? `stream-${Date.now()}`;
    const folderPath = await withSessionFolder(body.sessionId);
    const currentId = await currentSessionId();
    if (currentId !== body.sessionId) {
      try {
        await restoreSession(body.sessionId);
      } catch (restoreErr) {
        const msg = (restoreErr as Error).message ?? "";
        if (msg.includes("409") || msg.toLowerCase().includes("chat in progress")) {
          await cancelChat();
          await restoreSession(body.sessionId);
        } else {
          throw restoreErr;
        }
      }
    }
    const message = buildMessage(
      {
        message: body.message,
        yoloMode: Boolean(body.yoloMode),
        model: body.model ?? "default"
      },
      folderPath
    );
    await setChatMessage(message, Boolean(body.enableDeepPlan));
    const response: ChatRouteResponse = {
      ok: true,
      folderPath,
      sync: {
        sessionId: body.sessionId,
        clientMessageId,
        streamCorrelationId,
      },
    };
    return NextResponse.json(response);
  } catch (error) {
    const message = (error as Error).message;
    const noFolder = message.includes("No folder mapping exists");
    const response: ChatRouteResponse = {
      ok: false,
      error: message,
      code: noFolder ? "NO_SESSION_FOLDER" : "CHAT_PREP_FAILED",
    };
    const status = noFolder ? 409 : 500;
    return NextResponse.json(response, { status });
  }
}
