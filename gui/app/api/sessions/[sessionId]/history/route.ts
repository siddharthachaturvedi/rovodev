import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

type HistoryItem = {
  kind: "user" | "assistant" | "tool" | "system";
  text: string;
};

type HistoryResponse = {
  ok: boolean;
  messages: HistoryItem[];
  source: "session_context" | "none";
  warning?: string;
  error?: string;
  diagnostics?: {
    sessionId: string;
    messageHistoryEntries: number;
    parsedItems: number;
    hadRetries: boolean;
  };
};

const MAX_TOOL_TEXT = 1200;

function clipText(text: string, max = MAX_TOOL_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n...truncated`;
}

function safeJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const out = JSON.stringify(value, null, 2);
    return typeof out === "string" ? out : String(value);
  } catch {
    return String(value);
  }
}

function sanitizeUserPrompt(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "")
    .replace(/^Session folder policy \(hard\):.*\n?/gm, "")
    .replace(/^Only read\/write files in this session folder.*\n?/gm, "")
    .replace(/^Preferred model hint:.*\n?/gm, "")
    .replace(/^YOLO mode requested by user:.*\n?/gm, "")
    .replace(/^\s*User request:\s*\n?/gm, "")
    .trim();
}

function extractUserText(parts: unknown[]): string {
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.part_kind === "user-prompt" && typeof p.content === "string") {
      const cleaned = sanitizeUserPrompt(p.content);
      if (cleaned) return cleaned;
    }
  }
  return "";
}

function extractResponseText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.part_kind === "text" && typeof p.content === "string") {
      texts.push(p.content);
    }
  }
  return texts.join("\n").trim();
}

function extractToolText(parts: unknown[]): { kind: "tool"; text: string }[] {
  const items: { kind: "tool"; text: string }[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.part_kind === "tool-call") {
      const name = typeof p.tool_name === "string" ? p.tool_name : "tool";
      const args =
        p.args !== undefined
          ? clipText(safeJson(p.args))
          : p.content !== undefined
            ? clipText(safeJson(p.content))
            : "";
      items.push({ kind: "tool", text: args ? `Called ${name}\n${args}` : `Called ${name}` });
    } else if (p.part_kind === "tool-return") {
      const name = typeof p.tool_name === "string" ? p.tool_name : "tool";
      const result = p.content !== undefined ? clipText(safeJson(p.content)) : "";
      items.push({ kind: "tool", text: result ? `${name} returned\n${result}` : `${name} returned` });
    }
  }
  return items;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSessionContextFile(contextPath: string): Promise<{ raw: string; hadRetries: boolean }> {
  const delays = [0, 80, 200];
  let lastError: unknown;
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i] > 0) {
      await sleep(delays[i]);
    }
    try {
      const raw = await fs.readFile(contextPath, "utf8");
      if (!raw.trim()) {
        throw new Error("session_context.json was empty");
      }
      return { raw, hadRetries: i > 0 };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to read session_context.json");
}

function isFileMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; message?: string };
  return maybe.code === "ENOENT" || String(maybe.message ?? "").includes("ENOENT");
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  // Get session detail from backend to find log_dir
  try {
    const apiBase = process.env.ROVODEV_API_BASE ?? "http://127.0.0.1:8123";
    const token = process.env.ROVODEV_API_BEARER_TOKEN;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${apiBase}/v3/sessions/${sessionId}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const payload: HistoryResponse = {
        ok: false,
        source: "none",
        messages: [],
        warning: `Session lookup failed (${res.status})`,
      };
      return NextResponse.json(payload);
    }
    const session = (await res.json()) as Record<string, unknown>;
    const logDir = typeof session.log_dir === "string" ? session.log_dir : null;
    if (!logDir) {
      const payload: HistoryResponse = {
        ok: false,
        source: "none",
        messages: [],
        warning: "Session log directory is missing",
      };
      return NextResponse.json(payload);
    }

    const contextPath = path.join(logDir, "session_context.json");
    let contextRaw = "";
    let hadRetries = false;
    try {
      const loaded = await readSessionContextFile(contextPath);
      contextRaw = loaded.raw;
      hadRetries = loaded.hadRetries;
    } catch (error) {
      // New sessions often have no context file until first request/response.
      if (isFileMissingError(error)) {
        const payload: HistoryResponse = {
          ok: true,
          source: "none",
          messages: [],
          diagnostics: {
            sessionId,
            messageHistoryEntries: 0,
            parsedItems: 0,
            hadRetries: false,
          },
        };
        return NextResponse.json(payload);
      }
      throw error;
    }

    const context = JSON.parse(contextRaw) as Record<string, unknown>;
    const history = Array.isArray(context.message_history) ? context.message_history : [];

    const items: HistoryItem[] = [];
    for (const msg of history) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const parts = Array.isArray(m.parts) ? m.parts : [];

      if (m.kind === "request") {
        const userText = extractUserText(parts);
        if (userText) {
          items.push({ kind: "user", text: userText });
        }
        const tools = extractToolText(parts);
        items.push(...tools);
      } else if (m.kind === "response") {
        const tools = extractToolText(parts);
        items.push(...tools);
        const text = extractResponseText(parts);
        if (text) {
          items.push({ kind: "assistant", text });
        }
      }
    }
    const payload: HistoryResponse = {
      ok: true,
      source: "session_context",
      messages: items,
      diagnostics: {
        sessionId,
        messageHistoryEntries: history.length,
        parsedItems: items.length,
        hadRetries,
      },
    };
    return NextResponse.json(payload);
  } catch (error) {
    const payload: HistoryResponse = {
      ok: false,
      source: "none",
      messages: [],
      error: (error as Error).message,
    };
    return NextResponse.json(payload);
  }
}
