import { SessionSummary, ServerHealth, UiStatus } from "@/lib/types";

const DEFAULT_API_BASE = "http://127.0.0.1:8123";

function apiBase(): string {
  return process.env.ROVODEV_API_BASE ?? DEFAULT_API_BASE;
}

function authHeader(): Record<string, string> {
  const token = process.env.ROVODEV_API_BEARER_TOKEN;
  if (!token) {
    return {};
  }
  return {
    Authorization: `Bearer ${token}`
  };
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function getJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
      ...(init?.headers ?? {})
    },
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await readJsonSafe(response);
    throw new Error(`RovoDev API request failed (${path}): ${response.status} ${JSON.stringify(body)}`);
  }
  return readJsonSafe(response);
}

function parseSessionId(session: Record<string, unknown>, fallbackIndex: number): string {
  const candidates = [session.session_id, session.sessionId, session.id];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      return c;
    }
  }
  return `session-${fallbackIndex}`;
}

function parseSessionTitle(session: Record<string, unknown>, fallbackId: string): string {
  const candidates = [session.title, session.name];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      return c;
    }
  }
  return fallbackId;
}

function toSessionSummary(session: Record<string, unknown>, fallbackIndex: number): SessionSummary {
  const id = parseSessionId(session, fallbackIndex);
  return {
    id,
    title: parseSessionTitle(session, id),
    createdAt:
      typeof session.created_at === "string"
        ? session.created_at
        : typeof session.created === "string"
          ? session.created
          : undefined,
    updatedAt:
      typeof session.updated_at === "string"
        ? session.updated_at
        : typeof session.last_saved === "string"
          ? session.last_saved
          : undefined,
    latestResult: typeof session.latest_result === "string" ? session.latest_result : undefined,
    numMessages: typeof session.num_messages === "number" ? session.num_messages : undefined,
    parentSessionId: typeof session.parent_session_id === "string" ? session.parent_session_id : undefined
  };
}

async function listSessionsPage(page: number, pageSize: number): Promise<SessionSummary[]> {
  const body = await getJson(`/v3/sessions/list?page=${page}&page_size=${pageSize}`);
  if (!body || typeof body !== "object") {
    return [];
  }
  const payload = body as Record<string, unknown>;
  const sessionsRaw = Array.isArray(payload.sessions)
    ? payload.sessions
    : Array.isArray(payload.data)
      ? payload.data
      : [];
  return sessionsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((session, index) => toSessionSummary(session, index));
}

function sortSessionsNewestFirst(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const aTs = Date.parse((a.updatedAt ?? a.createdAt ?? "").replace(" ", "T")) || 0;
    const bTs = Date.parse((b.updatedAt ?? b.createdAt ?? "").replace(" ", "T")) || 0;
    return bTs - aTs;
  });
}

export async function fetchHealth(): Promise<ServerHealth | null> {
  try {
    const body = await getJson("/healthcheck");
    if (body && typeof body === "object") {
      return body as ServerHealth;
    }
    return null;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  const pageSize = 100;
  const maxPages = 50;
  const merged = new Map<string, SessionSummary>();

  for (let page = 1; page <= maxPages; page += 1) {
    const pageItems = await listSessionsPage(page, pageSize);
    if (!pageItems.length) {
      break;
    }
    for (const session of pageItems) {
      merged.set(session.id, session);
    }
    if (pageItems.length < pageSize) {
      break;
    }
  }

  return sortSessionsNewestFirst(Array.from(merged.values()));
}

export async function createSession(): Promise<SessionSummary> {
  const body = await getJson("/v3/sessions/create", { method: "POST" });
  if (!body || typeof body !== "object") {
    throw new Error("Invalid session create response");
  }
  const record = body as Record<string, unknown>;
  const session = (record.session && typeof record.session === "object"
    ? record.session
    : record) as Record<string, unknown>;
  const id = parseSessionId(session, 0);
  return {
    id,
    title: parseSessionTitle(session, id)
  };
}

export async function currentSessionId(): Promise<string | null> {
  try {
    const body = await getJson("/v3/sessions/current_session");
    if (body && typeof body === "object") {
      const s = body as Record<string, unknown>;
      return typeof s.id === "string" ? s.id : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function restoreSession(sessionId: string): Promise<void> {
  await getJson(`/v3/sessions/${sessionId}/restore`, { method: "POST" });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await getJson(`/v3/sessions/${sessionId}`, { method: "DELETE" });
}

export async function cancelChat(): Promise<void> {
  try {
    await fetch(`${apiBase()}/v3/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    // Best-effort cancel -- if it times out, proceed anyway
  }
}

export async function setChatMessage(message: string, enableDeepPlan: boolean): Promise<void> {
  await getJson("/v3/set_chat_message", {
    method: "POST",
    body: JSON.stringify({
      message,
      enable_deep_plan: enableDeepPlan
    })
  });
}

export async function fetchToolsCount(): Promise<number> {
  try {
    const body = await getJson("/v3/tools");
    if (Array.isArray(body)) {
      return body.length;
    }
    if (body && typeof body === "object") {
      const payload = body as Record<string, unknown>;
      if (Array.isArray(payload.tools)) {
        return payload.tools.length;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function fetchUsage(): Promise<unknown> {
  try {
    return await getJson("/v3/usage");
  } catch {
    return null;
  }
}

export function streamChatRequestUrl(): string {
  return `${apiBase()}/v3/stream_chat`;
}

export function streamChatHeaders(): Record<string, string> {
  return {
    Accept: "text/event-stream",
    ...authHeader()
  };
}

export async function fetchRuntimeStatus(): Promise<UiStatus> {
  const [health, usage, toolsCount, statusRaw, availableModesRaw, availableModelsRaw] = await Promise.all([
    fetchHealth(),
    fetchUsage(),
    fetchToolsCount(),
    getJson("/v3/status").catch(() => null),
    getJson("/v3/available-modes").catch(() => null),
    getJson("/v3/agent-models").catch(() => null)
  ]);

  const statusObj = statusRaw && typeof statusRaw === "object" ? (statusRaw as Record<string, unknown>) : {};
  const accountObj =
    statusObj.account && typeof statusObj.account === "object" ? (statusObj.account as Record<string, unknown>) : {};
  const modelObj =
    statusObj.model && typeof statusObj.model === "object" ? (statusObj.model as Record<string, unknown>) : {};

  const modesPayload =
    availableModesRaw && typeof availableModesRaw === "object"
      ? (availableModesRaw as Record<string, unknown>)
      : {};
  const modelsPayload =
    availableModelsRaw && typeof availableModelsRaw === "object"
      ? (availableModelsRaw as Record<string, unknown>)
      : {};

  const availableModes = Array.isArray(modesPayload.modes)
    ? modesPayload.modes
        .map((m) => {
          if (typeof m === "string") {
            return m;
          }
          if (m && typeof m === "object" && typeof (m as Record<string, unknown>).mode === "string") {
            return (m as Record<string, unknown>).mode as string;
          }
          return null;
        })
        .filter((m): m is string => Boolean(m))
    : [];

  const modelsRaw = Array.isArray(modelsPayload.models) ? modelsPayload.models : [];
  const availableModels = modelsRaw
    .map((m) => {
      if (!m || typeof m !== "object") {
        return null;
      }
      const model = m as Record<string, unknown>;
      const id = typeof model.model_id === "string" ? model.model_id : "";
      const name =
        typeof model.name === "string"
          ? model.name
          : typeof model.humanReadableName === "string"
            ? model.humanReadableName
            : id;
      if (!id) {
        return null;
      }
      return { id, name };
    })
    .filter((m): m is { id: string; name: string } => Boolean(m));

  return {
    health,
    usage,
    toolsCount,
    userLabel:
      (typeof accountObj.email === "string" && accountObj.email) ||
      (typeof accountObj.accountId === "string" && accountObj.accountId) ||
      process.env.USER ||
      "unknown-user",
    accountId: typeof accountObj.accountId === "string" ? accountObj.accountId : null,
    currentMode: typeof statusObj.agentMode === "string" ? statusObj.agentMode : null,
    currentModelName: typeof modelObj.modelName === "string" ? modelObj.modelName : null,
    currentModelId: typeof modelObj.modelId === "string" ? modelObj.modelId : null,
    availableModes,
    availableModels
  };
}

export async function setAgentMode(mode: string): Promise<void> {
  await getJson("/v3/agent-mode", {
    method: "PUT",
    body: JSON.stringify({ mode })
  });
}

export async function setAgentModel(modelId: string): Promise<void> {
  await getJson("/v3/agent-model", {
    method: "PUT",
    body: JSON.stringify({ model_id: modelId })
  });
}

export async function resetAgent(): Promise<void> {
  await getJson("/v3/reset", { method: "POST", signal: AbortSignal.timeout(15000) });
}

export async function clearAgent(): Promise<void> {
  await getJson("/v3/clear", { method: "POST", signal: AbortSignal.timeout(15000) });
}

export async function fetchSites(): Promise<{ currentSite: string; availableSites: string[] }> {
  const body = await getJson("/v3/sites");
  if (body && typeof body === "object") {
    const payload = body as Record<string, unknown>;
    return {
      currentSite: typeof payload.current_site === "string" ? payload.current_site : "",
      availableSites: Array.isArray(payload.available_sites) ? payload.available_sites.filter((s): s is string => typeof s === "string") : [],
    };
  }
  return { currentSite: "", availableSites: [] };
}

export async function setSiteUrl(siteUrl: string): Promise<void> {
  await getJson("/v3/set-site-url", {
    method: "POST",
    body: JSON.stringify({ site_url: siteUrl })
  });
}

export async function shutdownServer(): Promise<void> {
  try {
    await fetch(`${apiBase()}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Expected -- server shuts down
  }
}
