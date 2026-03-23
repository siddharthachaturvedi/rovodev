import { NextRequest, NextResponse } from "next/server";
import {
  cancelChat,
  currentSessionId,
  isRovoDevApiError,
  restoreSession,
  setChatMessage,
  toRouteError,
} from "@/lib/server/rovodev";
import { ensureSessionFolder, withSessionFolder } from "@/lib/server/sessionStore";

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
      code: string;
    };

function isChatInProgressError(error: unknown): boolean {
  if (isRovoDevApiError(error)) {
    return error.status === 409;
  }
  const msg = (error as Error)?.message ?? "";
  return msg.includes("409") || msg.toLowerCase().includes("chat in progress");
}

function isSessionNotFoundError(error: unknown): boolean {
  if (isRovoDevApiError(error)) {
    return error.status === 404;
  }
  const msg = (error as Error)?.message ?? "";
  return msg.includes("404") || msg.toLowerCase().includes("session not found");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMessage(payload: Required<Pick<Payload, "message" | "yoloMode" | "model">>, folderPath: string): string {
  const header = [
    `Session folder policy (hard): ${folderPath}`,
    "Only read/write files in this session folder unless the user explicitly changes policy.",
    "If any artifact is created outside this folder, copy it into this session folder before finishing and return the final in-folder path.",
    `Preferred model hint: ${payload.model}`,
    `YOLO mode requested by user: ${payload.yoloMode ? "on" : "off"}`
  ].join("\n");
  return `${header}\n\nUser request:\n${payload.message}`;
}

async function resolveSessionFolder(sessionId: string): Promise<string> {
  try {
    return await withSessionFolder(sessionId);
  } catch (error) {
    const msg = (error as Error).message ?? "";
    if (msg.includes("No folder mapping exists")) {
      return await ensureSessionFolder(sessionId);
    }
    throw error;
  }
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
    const folderPath = await resolveSessionFolder(body.sessionId);
    const currentId = await currentSessionId();
    if (currentId !== body.sessionId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await restoreSession(body.sessionId);
          break;
        } catch (restoreErr) {
          if (isChatInProgressError(restoreErr)) {
            if (attempt === 4) {
              throw restoreErr;
            }
            await cancelChat();
            await sleep(200 + attempt * 200);
            continue;
          }
          if (isSessionNotFoundError(restoreErr)) {
            if (attempt === 4) {
              throw restoreErr;
            }
            await sleep(200 + attempt * 200);
            continue;
          }
          if (attempt === 4) {
            throw restoreErr;
          }
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await setChatMessage(message, Boolean(body.enableDeepPlan));
        break;
      } catch (setErr) {
        if (!isChatInProgressError(setErr) || attempt === 2) {
          throw setErr;
        }
        await cancelChat();
        await sleep(200 + attempt * 200);
      }
    }
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
    if (!noFolder && isRovoDevApiError(error)) {
      const mapped = toRouteError(error, "CHAT_PREP_FAILED");
      const response: ChatRouteResponse = {
        ok: false,
        error: String(mapped.body.error ?? "Failed to prepare chat"),
        code: String(mapped.body.code ?? "CHAT_PREP_FAILED"),
      };
      return NextResponse.json(response, { status: mapped.status });
    }
    const response: ChatRouteResponse = {
      ok: false,
      error: message,
      code: noFolder ? "NO_SESSION_FOLDER" : "CHAT_PREP_FAILED",
    };
    const status = noFolder ? 409 : 500;
    return NextResponse.json(response, { status });
  }
}
