"use client";

import { FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionSummary, UiStatus } from "@/lib/types";

type StreamItem = {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "tool" | "system";
  text: string;
};

type StreamPhase = "idle" | "sending" | "streaming" | "closing" | "done" | "error";

const DEFAULT_MODE_OPTIONS = ["default", "ask", "plan"];
const DEFAULT_MODEL_OPTIONS = [{ id: "default", name: "Auto" }];
const CHAT_STORE_KEY = "rovodev-chat-items-v1";
const MODE_ORDER = ["ask", "default", "plan"];

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function clipText(text: string, max = 1000) {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n...truncated`;
}

function toTitleCase(text: string): string {
  return text.replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizeModelLabel(modelId: string, rawName: string): string {
  const withoutMarkup = rawName
    .replace(/\[italic green\]preview\[\/italic green\]/gi, "Preview")
    .replace(/\s+/g, " ")
    .trim();
  const hasPreview = /preview/i.test(withoutMarkup);
  const base = withoutMarkup
    .replace(/\(\s*preview\s*\)/gi, "")
    .replace(/\bpreview\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  let label = base || rawName;
  if (modelId.startsWith("google:") && !/^google\s+/i.test(label)) {
    label = `Google ${label}`;
  }
  return hasPreview ? `${label} (Preview)` : label;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={`b-${match.index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={`c-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (match[2] && match[3]) {
      nodes.push(<a key={`a-${match.index}`} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>);
    } else {
      nodes.push(token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function renderMarkdownText(text: string): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  function isTableRow(l: string): boolean {
    const t = l.trim();
    return t.startsWith("|") && t.endsWith("|") && t.includes("|");
  }
  function isSeparatorRow(l: string): boolean {
    return /^\|[\s:*-]+(\|[\s:*-]+)*\|$/.test(l.trim());
  }
  function parseCells(row: string): string[] {
    return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  }
  function parseAlign(sep: string): ("left" | "center" | "right" | undefined)[] {
    return parseCells(sep).map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return undefined;
    });
  }

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i += 1; continue; }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <pre key={`code-${i}`} className="md-codeblock" data-lang={lang || undefined}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      const level = (line.match(/^(#+)/)![1].length) as 1 | 2 | 3;
      const heading = line.replace(/^#{1,3}\s+/, "");
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      blocks.push(<Tag key={`h-${i}`} className="md-heading">{renderInlineMarkdown(heading)}</Tag>);
      i += 1;
      continue;
    }

    if (line === "---" || line === "***") {
      blocks.push(<hr key={`hr-${i}`} />);
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1].trim())) {
      const headerCells = parseCells(lines[i]);
      const aligns = parseAlign(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseCells(lines[i]));
        i += 1;
      }
      blocks.push(
        <div className="md-table-wrap" key={`table-${i}`}>
          <table className="md-table">
            <thead>
              <tr>
                {headerCells.map((cell, ci) => (
                  <th key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                    {renderInlineMarkdown(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {headerCells.map((_, ci) => (
                    <td key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                      {renderInlineMarkdown(row[ci] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(<li key={`ol-${i}`}>{renderInlineMarkdown(lines[i].trim().replace(/^\d+\.\s+/, ""))}</li>);
        i += 1;
      }
      blocks.push(<ol key={`ol-wrap-${i}`}>{items}</ol>);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(<li key={`ul-${i}`}>{renderInlineMarkdown(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>);
        i += 1;
      }
      blocks.push(<ul key={`ul-wrap-${i}`}>{items}</ul>);
      continue;
    }
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(---|```|\*\*\*|#{1,3}\s+|\d+\.\s+|[-*]\s+)/.test(lines[i].trim()) &&
      !isTableRow(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    if (paragraphLines.length) {
      blocks.push(
        <p key={`p-${i}`}>
          {paragraphLines.map((pLine, idx) => (
            <span key={`line-${idx}`}>
              {renderInlineMarkdown(pLine)}
              {idx < paragraphLines.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>
      );
    }
  }
  return <div className="message-markdown">{blocks}</div>;
}

function extractToolLabel(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  const cleaned = firstLine
    .replace(/^(Called |Returned |Tool: |System: )/, "")
    .replace(/^mcp__[^_]+__/, "");
  if (cleaned.startsWith("[")) {
    const bracket = cleaned.indexOf("]");
    if (bracket > 0) return cleaned.slice(0, bracket + 1);
  }
  if (cleaned.length <= 50) return cleaned;
  return `${cleaned.slice(0, 47)}...`;
}

type Turn = {
  kind: "user" | "rovo";
  items: StreamItem[];
};

function groupIntoTurns(items: StreamItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      turns.push({ kind: "user", items: [item] });
    } else {
      const last = turns[turns.length - 1];
      if (last && last.kind === "rovo") {
        last.items.push(item);
      } else {
        turns.push({ kind: "rovo", items: [item] });
      }
    }
  }
  return turns;
}

function formatSessionTime(isoLike?: string): string {
  if (!isoLike) return "recent";
  const compact = isoLike.replace("T", " ").replace(".000000", "");
  const [date, time] = compact.split(" ");
  if (!date || !time) return compact;
  return `${date} ${time.slice(0, 5)}`;
}

function readStore(): Record<string, StreamItem[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CHAT_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StreamItem[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, StreamItem[]>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(store));
}

function parseUsage(usage: unknown): {
  used: string;
  total: string;
  unlimited: boolean;
  link?: string;
} {
  if (!usage || typeof usage !== "object") {
    return { used: "--", total: "--", unlimited: false };
  }
  const content =
    "content" in usage && usage.content && typeof usage.content === "object"
      ? (usage.content as Record<string, unknown>)
      : (usage as Record<string, unknown>);
  const total = content.credit_total;
  const unlimited = typeof total === "number" && total < 0;
  const usageMessage =
    content.view_usage_message && typeof content.view_usage_message === "object"
      ? (content.view_usage_message as Record<string, unknown>)
      : null;
  const cta =
    usageMessage?.ctaLink && typeof usageMessage.ctaLink === "object"
      ? (usageMessage.ctaLink as Record<string, unknown>)
      : null;
  return {
    used: typeof content.credit_used === "number" ? content.credit_used.toLocaleString() : "--",
    total: unlimited ? "Unlimited" : typeof total === "number" ? total.toLocaleString() : "--",
    unlimited,
    link: typeof cta?.link === "string" ? cta.link : undefined,
  };
}

type FileEntry = { name: string; size: number; mtime: string; isDirectory: boolean };
type SitesInfo = { currentSite: string; availableSites: string[] };
type SetupInfo = {
  auth: { authenticated: boolean; detail: string };
  backend: { running: boolean; pid: number | null };
  apiPort: number;
  logFile: string;
};
type SetupPhase = "loading" | "needs_auth" | "backend_offline" | "ready";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HomePage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState("default");
  const [model, setModel] = useState("default");
  const [deepPlan, setDeepPlan] = useState(false);
  const [yolo, setYolo] = useState(false);
  const [streamItems, setStreamItems] = useState<StreamItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [error, setError] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sites, setSites] = useState<SitesInfo>({ currentSite: "", availableSites: [] });
  const [setupInfo, setSetupInfo] = useState<SetupInfo | null>(null);
  const [sessionFiles, setSessionFiles] = useState<FileEntry[]>([]);
  const [sessionFolderPath, setSessionFolderPath] = useState<string | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>("idle");
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingPending, setOnboardingPending] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const assistantDraftIdRef = useRef<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSessionIdRef = useRef<string>("");
  const lastStreamActivityRef = useRef<number>(Date.now());
  const streamDoneRef = useRef<boolean>(false);
  const sendingRef = useRef<boolean>(false);
  const streamTokenRef = useRef<string>("");
  const streamRetryRef = useRef<number>(0);

  useEffect(() => { sendingRef.current = sending; }, [sending]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSidebarCollapsed(localStorage.getItem("rovodev-sidebar-collapsed") === "true");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "rovodev-hub-onboarding-v1";
    const done = localStorage.getItem(key) === "done";
    setOnboardingPending(!done);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("rovodev-sidebar-collapsed", String(next));
      }
      return next;
    });
  }, []);

  const modelOptions = status?.availableModels?.length ? status.availableModels : DEFAULT_MODEL_OPTIONS;
  const modeOptions = status?.availableModes?.length ? status.availableModes : DEFAULT_MODE_OPTIONS;
  const orderedModes = [
    ...MODE_ORDER.filter((o) => modeOptions.includes(o)),
    ...modeOptions.filter((o) => !MODE_ORDER.includes(o)),
  ];
  const normalizedModelOptions = modelOptions.map((o) => ({
    ...o,
    name: o.id === "default" ? "Auto" : normalizeModelLabel(o.id, o.name),
  }));

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const usage = useMemo(() => parseUsage(status?.usage), [status?.usage]);
  const isHealthy = status?.health?.status === "healthy";
  const setupPhase = useMemo<SetupPhase>(() => {
    if (!setupInfo) return "loading";
    if (!setupInfo.auth.authenticated) return "needs_auth";
    if (!setupInfo.backend.running || !isHealthy) return "backend_offline";
    return "ready";
  }, [setupInfo, isHealthy]);

  useEffect(() => {
    if (!onboardingPending) return;
    setOnboardingOpen(true);
    if (setupPhase === "needs_auth") {
      setOnboardingStep(1);
    } else if (setupPhase === "backend_offline") {
      setOnboardingStep(2);
    } else if (setupPhase === "ready") {
      setOnboardingStep(3);
    } else {
      setOnboardingStep(0);
    }
  }, [onboardingPending, setupPhase]);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  function selectSession(id: string) {
    stopStream();
    markSyncStatus("");
    activeSessionIdRef.current = id;
    setActiveSessionId(id);
  }

  async function loadSessions() {
    setLoadingSessions(true);
    setError("");
    try {
      const res = await fetch("/api/sessions", { signal: AbortSignal.timeout(10000) });
      const payload = (await res.json()) as { ok?: boolean; sessions: SessionSummary[]; error?: string; warning?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to load sessions");
      if (payload.ok === false && payload.warning) {
        setError(payload.warning);
      }
      setSessions(payload.sessions ?? []);
      const currentId = activeSessionIdRef.current;
      if (payload.sessions?.length && !currentId) {
        selectSession(payload.sessions[0].id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadStatus() {
    try {
      const res = await fetch("/api/status", { signal: AbortSignal.timeout(10000) });
      const payload = (await res.json()) as UiStatus;
      setStatus(payload);
      if (payload.currentMode) setMode(payload.currentMode);
      if (payload.currentModelId) setModel(payload.currentModelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createNewSession() {
    setError("");
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const payload = (await res.json()) as { session?: SessionSummary; error?: string };
      if (!res.ok || !payload.session) throw new Error(payload.error ?? "Could not create session");
      setSessions((prev) => [payload.session as SessionSummary, ...prev]);
      selectSession(payload.session.id);
      setStreamItems([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteSession(sessionId: string) {
    setError("");
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Could not delete session");
      }
    } catch {
      // Best-effort delete from server
    }
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeSessionIdRef.current === sessionId) {
      const remaining = sessions.filter((s) => s.id !== sessionId);
      selectSession(remaining.length ? remaining[0].id : "");
      setStreamItems([]);
    }
    const store = readStore();
    delete store[sessionId];
    writeStore(store);
  }

  function clearChat() {
    setStreamItems([]);
    markSyncStatus("Chat cleared locally.");
    if (activeSessionId) {
      const store = readStore();
      delete store[activeSessionId];
      writeStore(store);
    }
  }

  function stopStream() {
    setStreamPhase("closing");
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    assistantDraftIdRef.current = null;
    setSending(false);
    setStreamPhase("idle");
  }

  async function updateMode(nextMode: string) {
    setMode(nextMode);
    try {
      await fetch("/api/runtime/mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function updateModel(nextModelId: string) {
    setModel(nextModelId);
    try {
      await fetch("/api/runtime/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: nextModelId }),
      });
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function loadSettings() {
    try {
      const res = await fetch("/api/settings", { signal: AbortSignal.timeout(10000) });
      const payload = (await res.json()) as {
        runtime?: UiStatus;
        sites?: SitesInfo;
        setup?: SetupInfo;
      };
      if (payload.sites) setSites(payload.sites);
      if (payload.runtime) setStatus(payload.runtime);
      if (payload.setup) setSetupInfo(payload.setup);
    } catch { /* non-critical */ }
  }

  async function settingsAction(action: string, extra?: Record<string, string>) {
    setSettingsLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
        signal: AbortSignal.timeout(20000),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok) throw new Error(body.error ?? "Action failed");
      if (
        action === "set-site-url" ||
        action === "start-backend" ||
        action === "stop-backend" ||
        action === "restart-backend" ||
        action === "auth-status"
      ) {
        await loadSettings();
      }
      if (action === "reset" || action === "clear" || action === "cancel") await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSettingsLoading(false);
    }
  }

  async function loadSessionFiles(sid?: string) {
    const id = sid ?? activeSessionIdRef.current;
    if (!id) { setSessionFiles([]); setSessionFolderPath(null); return; }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/files`, { signal: AbortSignal.timeout(5000) });
      const payload = (await res.json()) as { files: FileEntry[]; folderPath: string | null };
      if (activeSessionIdRef.current === id) {
        setSessionFiles(payload.files ?? []);
        setSessionFolderPath(payload.folderPath ?? null);
      }
    } catch {
      setSessionFiles([]);
    }
  }

  function addStreamItem(item: Omit<StreamItem, "id" | "ts">) {
    const trimmed = item.text.trim();
    if (!trimmed) return "";
    if (item.kind === "system" && /^(undefined|null)$/i.test(trimmed)) return "";
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setStreamItems((prev) => [...prev, { id, ts: new Date().toISOString(), ...item }]);
    return id;
  }

  function markSyncStatus(next: string) {
    setSyncStatus(next);
  }

  function finishOnboarding() {
    if (typeof window !== "undefined") {
      localStorage.setItem("rovodev-hub-onboarding-v1", "done");
    }
    setOnboardingPending(false);
    setOnboardingOpen(false);
    setOnboardingStep(0);
  }

  function logLifecycle(stage: string, meta?: Record<string, unknown>) {
    console.debug(`[rovodev-sync] ${stage}`, meta ?? {});
  }

  function appendAssistantChunk(chunk: string) {
    if (!chunk) return;
    lastStreamActivityRef.current = Date.now();
    const currentId = assistantDraftIdRef.current;
    if (!currentId) {
      assistantDraftIdRef.current = addStreamItem({ kind: "assistant", text: chunk });
      return;
    }
    setStreamItems((prev) =>
      prev.map((item) => (item.id !== currentId ? item : { ...item, text: `${item.text}${chunk}` })),
    );
  }

  async function sendChat(event?: FormEvent) {
    event?.preventDefault();
    setError("");
    if (!activeSessionId) { setError("Select or create a session first."); return; }
    if (!message.trim()) return;
    const selectedSessionId = activeSessionId;
    const text = message;
    const clientMessageId = `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const streamCorrelationId = `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const streamToken = `${selectedSessionId}:${streamCorrelationId}`;
    logLifecycle("send_queued", { selectedSessionId, clientMessageId, streamCorrelationId });

    stopStream();
    streamTokenRef.current = streamToken;
    streamRetryRef.current = 0;
    setSending(true);
    setStreamPhase("sending");
    markSyncStatus("Preparing request...");
    assistantDraftIdRef.current = null;
    streamDoneRef.current = false;
    addStreamItem({ kind: "user", text });

    const payload = {
      sessionId: selectedSessionId,
      message: text,
      enableDeepPlan: deepPlan,
      yoloMode: yolo,
      model,
      clientMessageId,
      streamCorrelationId,
    };

    try {
      logLifecycle("chat_prepare_start", { selectedSessionId, streamCorrelationId });
      const prepRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const prepBody = (await prepRes.json()) as {
        ok?: boolean;
        error?: string;
        sync?: { sessionId: string; clientMessageId: string; streamCorrelationId: string };
      };
      if (!prepRes.ok) {
        throw new Error(prepBody.error ?? "Failed to set chat message");
      }
      logLifecycle("chat_prepare_sync", prepBody.sync);
      logLifecycle("chat_prepare_done", { selectedSessionId, streamCorrelationId });
    } catch (err) {
      setSending(false);
      setStreamPhase("error");
      markSyncStatus("Failed before stream start.");
      setError((err as Error).message);
      logLifecycle("chat_prepare_error", { selectedSessionId, streamCorrelationId, message: (err as Error).message });
      return;
    }

    const streamUrl = `/api/chat/stream?sessionId=${encodeURIComponent(selectedSessionId)}&yolo=${yolo}`;
    const finalizeStream = (isClean: boolean, note: string) => {
      if (streamTokenRef.current !== streamToken) return;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      assistantDraftIdRef.current = null;
      setSending(false);
      setStreamPhase(isClean ? "done" : "error");
      markSyncStatus(note);
      logLifecycle("stream_finalize", { selectedSessionId, streamCorrelationId, isClean, note });
      loadSessionFiles(selectedSessionId);
    };

    const attachStream = (stream: EventSource) => {
      eventSourceRef.current = stream;
      lastStreamActivityRef.current = Date.now();

      const eventNames = ["text", "tool-call", "tool-return", "part_start", "part_delta", "error"];
      for (const eventName of eventNames) {
        stream.addEventListener(eventName, ((ev: MessageEvent) => {
          if (streamTokenRef.current !== streamToken || activeSessionIdRef.current !== selectedSessionId) return;
          lastStreamActivityRef.current = Date.now();
          const raw = ev.data;
          const parsed = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })();

          if (eventName === "text") {
            setStreamPhase("streaming");
            markSyncStatus("Streaming response...");
            appendAssistantChunk(parsed?.content ? String(parsed.content) : String(raw));
          } else if (eventName === "tool-call") {
            const toolName = String(parsed?.tool_name ?? "tool");
            const args = safeStringify(parsed?.args ?? {});
            addStreamItem({ kind: "tool", text: `Called ${toolName}\n${clipText(args, 400)}` });
          } else if (eventName === "tool-return") {
            const toolName = String(parsed?.tool_name ?? "tool");
            const result = safeStringify(parsed?.content ?? parsed ?? raw);
            addStreamItem({ kind: "tool", text: `${toolName} returned\n${clipText(result, 600)}` });
          } else if (eventName === "part_start" || eventName === "part_delta") {
            const delta = parsed?.delta && typeof parsed.delta === "object" ? (parsed.delta as Record<string, unknown>) : {};
            const part = parsed?.part && typeof parsed.part === "object" ? (parsed.part as Record<string, unknown>) : {};
            const content = typeof part.content === "string" ? part.content : typeof delta.content_delta === "string" ? delta.content_delta : "";
            if (content) {
              setStreamPhase("streaming");
              markSyncStatus("Streaming response...");
              appendAssistantChunk(content);
            }
          } else if (eventName === "error") {
            addStreamItem({ kind: "system", text: clipText(safeStringify(parsed ?? raw)) });
          }
        }) as EventListener);
      }

      stream.addEventListener("close", () => {
        if (streamTokenRef.current !== streamToken) return;
        streamDoneRef.current = true;
        logLifecycle("stream_close", { selectedSessionId, streamCorrelationId });
        finalizeStream(true, "Synced with backend.");
      });

      stream.addEventListener("request-usage", () => {
        if (streamTokenRef.current !== streamToken) return;
        lastStreamActivityRef.current = Date.now();
      });

      const suppressedEvents = new Set([
        "run_start", "run_end", "agent_start", "agent_end",
        "part_start", "part_delta", "part_end",
        "model_request_start", "model_request_end",
        "text", "tool_call", "tool_return",
        "user-prompt", "request-usage", "close",
      ]);

      stream.onmessage = (ev) => {
        if (streamTokenRef.current !== streamToken || activeSessionIdRef.current !== selectedSessionId) return;
        const raw = ev.data;
        if (!raw || raw === "[DONE]") return;
        lastStreamActivityRef.current = Date.now();
        const parsed = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })();
        const marker =
          (typeof parsed?.event_kind === "string" && parsed.event_kind) ||
          (typeof parsed?.part_kind === "string" && parsed.part_kind) ||
          (typeof parsed?.type === "string" && parsed.type) ||
          "";
        if (suppressedEvents.has(marker) || !marker) return;
        addStreamItem({ kind: "system", text: `[${marker}] ${clipText(safeStringify(parsed ?? raw), 500)}` });
      };

      stream.onerror = () => {
        if (streamTokenRef.current !== streamToken) return;
        if (streamDoneRef.current) {
          finalizeStream(true, "Synced with backend.");
          return;
        }
        if (streamRetryRef.current < 1) {
          streamRetryRef.current += 1;
          logLifecycle("stream_retry", { selectedSessionId, streamCorrelationId, retry: streamRetryRef.current });
          markSyncStatus("Stream interrupted, retrying...");
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          window.setTimeout(() => {
            if (streamTokenRef.current !== streamToken || activeSessionIdRef.current !== selectedSessionId) return;
            const retried = new EventSource(streamUrl);
            attachStream(retried);
          }, 500);
          return;
        }
        logLifecycle("stream_error_terminal", { selectedSessionId, streamCorrelationId });
        finalizeStream(false, "Stream disconnected before completion.");
      };
    };

    const stream = new EventSource(streamUrl);
    attachStream(stream);

    setMessage("");
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sending && message.trim()) sendChat();
    }
  }

  // Lifecycle
  useEffect(() => {
    loadSessions();
    loadStatus();
    loadSettings();

    const poll = () => {
      if (document.visibilityState === "visible") {
        loadStatus();
        loadSessions();
      }
    };
    const si = window.setInterval(poll, 30000);

    const stuckChecker = window.setInterval(() => {
      if (sendingRef.current && Date.now() - lastStreamActivityRef.current > 90000) {
        fetch("/api/cancel", { method: "POST" }).catch(() => {});
        stopStream();
        setError("Chat appeared stuck and was auto-cancelled. Try again.");
      }
    }, 10000);

    return () => {
      window.clearInterval(si);
      window.clearInterval(stuckChecker);
      stopStream();
    };
  }, []);

  useEffect(() => {
    if (!activeSessionId) { setStreamItems([]); setSessionFiles([]); setSessionFolderPath(null); return; }
    const latestResultSnapshot = activeSession?.latestResult;
    setStreamItems([]);
    markSyncStatus("Loading thread from backend...");
    logLifecycle("restore_start", { activeSessionId });
    fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/history`, { signal: AbortSignal.timeout(10000) })
      .then((res) => res.json())
      .then((payload: {
        ok?: boolean;
        messages?: Array<{ kind: string; text: string }>;
        diagnostics?: { parsedItems?: number };
        warning?: string;
        error?: string;
      }) => {
        if (activeSessionIdRef.current !== activeSessionId) return;
        const msgs = payload.messages ?? [];
        if (msgs.length > 0) {
          const items: StreamItem[] = msgs.map((m, idx) => ({
            id: `history-${activeSessionId}-${idx}`,
            ts: new Date().toISOString(),
            kind: (m.kind === "user" || m.kind === "assistant" || m.kind === "tool" || m.kind === "system") ? m.kind : "system",
            text: m.text,
          }));
          setStreamItems(items);
          markSyncStatus(`Loaded ${items.length} items from backend history.`);
          logLifecycle("restore_backend_history", { activeSessionId, items: items.length });
          return;
        }

        const store = readStore();
        const saved = store[activeSessionId];
        if (saved?.length) {
          setStreamItems(saved);
          markSyncStatus("Loaded local cached thread (backend history empty).");
          logLifecycle("restore_local_cache", { activeSessionId, items: saved.length });
          return;
        }

        if (latestResultSnapshot) {
          setStreamItems([{
            id: `bootstrap-${activeSessionId}`,
            ts: new Date().toISOString(),
            kind: "assistant",
            text: latestResultSnapshot,
          }]);
          markSyncStatus("Loaded latest backend result only.");
          logLifecycle("restore_latest_result", { activeSessionId });
          return;
        }

        if (payload.warning || payload.error) {
          setError(payload.warning ?? payload.error ?? "");
        }
        markSyncStatus("Thread is empty.");
        logLifecycle("restore_empty", { activeSessionId });
      })
      .catch(() => {
        if (activeSessionIdRef.current !== activeSessionId) return;
        const store = readStore();
        const saved = store[activeSessionId];
        if (saved?.length) {
          setStreamItems(saved);
          markSyncStatus("Loaded local cached thread (backend unavailable).");
          logLifecycle("restore_local_cache_on_error", { activeSessionId, items: saved.length });
          return;
        }
        if (latestResultSnapshot) {
          setStreamItems([{
            id: `bootstrap-${activeSessionId}`,
            ts: new Date().toISOString(),
            kind: "assistant",
            text: latestResultSnapshot,
          }]);
          markSyncStatus("Loaded latest backend result only.");
          logLifecycle("restore_latest_result_on_error", { activeSessionId });
          return;
        }
        markSyncStatus("Thread could not be restored.");
        logLifecycle("restore_error", { activeSessionId });
      });
    loadSessionFiles(activeSessionId);
    const fi = window.setInterval(() => loadSessionFiles(), 15000);
    return () => window.clearInterval(fi);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) return;
    const store = readStore();
    store[activeSessionId] = streamItems.slice(-120);
    writeStore(store);
  }, [activeSessionId, streamItems]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [streamItems]);

  return (
    <div className="app-layout">
      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <span className={`status-dot ${isHealthy ? "is-online" : ""}`} />
          <span>RovoDev Hub</span>
        </div>
        <div className="topbar-controls">
          <button
            type="button"
            className={deepPlan ? "toggle-pill is-on" : "toggle-pill"}
            onClick={() => setDeepPlan(!deepPlan)}
          >
            <span className="toggle-dot" />
            Deep Plan
          </button>
          <button
            type="button"
            className={yolo ? "toggle-pill is-on" : "toggle-pill"}
            onClick={() => setYolo(!yolo)}
          >
            <span className="toggle-dot" />
            YOLO
          </button>
          {sending && (
            <button type="button" className="toggle-pill" onClick={stopStream} title="Stop generating">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>
              Stop
            </button>
          )}
          <button type="button" className="toggle-pill" onClick={clearChat} title="Clear chat">
              Clear
          </button>
          <span className="usage-pill">
            {usage.used} / {usage.total}
            {usage.link ? <a href={usage.link} target="_blank" rel="noreferrer">details</a> : null}
          </span>
          <button type="button" className="icon-btn" onClick={() => { setSettingsOpen(true); loadSettings(); }} title="Settings">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </header>

      {!isHealthy && status !== null && (
        <div className="health-banner">
          Backend unreachable. Is <code>acli rovodev serve</code> running?
        </div>
      )}

      {/* ── Main area ── */}
      <div className="main-area">
        {/* ── Sidebar ── */}
        <aside className={sidebarCollapsed ? "sidebar is-collapsed" : "sidebar"}>
          <div className="sidebar-header">
            {!sidebarCollapsed && <h2>Threads</h2>}
            <div className="sidebar-actions">
              {!sidebarCollapsed && (
                <>
                  <button type="button" className="icon-btn" onClick={createNewSession} title="New thread">+</button>
                  <button type="button" className="icon-btn" onClick={loadSessions} title="Refresh">&#8635;</button>
                </>
              )}
              <button type="button" className="icon-btn sidebar-collapse-btn" onClick={toggleSidebar} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {sidebarCollapsed
                    ? <path d="M6 3l5 5-5 5" />
                    : <path d="M10 3L5 8l5 5" />}
                </svg>
              </button>
            </div>
          </div>
          {!sidebarCollapsed && (
            <>
              <div className="session-list">
                {loadingSessions && sessions.length === 0 && (
                  <div className="sidebar-empty">Loading...</div>
                )}
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={session.id === activeSessionId ? "session-row is-active" : "session-row"}
                    onClick={() => selectSession(session.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") selectSession(session.id); }}
                  >
                    <span className="session-row-title">{session.title}</span>
                    <span className="session-row-meta">
                      <span>{formatSessionTime(session.updatedAt ?? session.createdAt)}</span>
                      {session.numMessages ? <span>{session.numMessages} msg</span> : null}
                    </span>
                    <button
                      type="button"
                      className="session-delete"
                      title="Delete thread"
                      onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                    >
                      &times;
                    </button>
                  </div>
                ))}
                {!loadingSessions && sessions.length === 0 && (
                  <div className="sidebar-empty">No threads yet</div>
                )}
              </div>

              {/* File explorer */}
              <div className="sidebar-files">
                <div className="sidebar-files-header">
                  <button
                    type="button"
                    className="sidebar-files-toggle"
                    onClick={() => setFilesExpanded(!filesExpanded)}
                  >
                    <span className="files-toggle">{filesExpanded ? "\u25BE" : "\u25B8"}</span>
                    <span>Files</span>
                    {sessionFiles.length > 0 && <span className="files-badge">{sessionFiles.length}</span>}
                  </button>
                  {sessionFolderPath && (
                    <button
                      type="button"
                      className="files-open-btn"
                      title="Open folder in Finder"
                      onClick={() => {
                        fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/files`).catch(() => {});
                        window.open(`vscode://file${sessionFolderPath}`, "_blank");
                      }}
                    >
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11L11 5M11 5H6M11 5v5"/></svg>
                    </button>
                  )}
                </div>
                {filesExpanded && (
                  <div className="files-list">
                    {!activeSessionId ? (
                      <div className="sidebar-empty">No session selected</div>
                    ) : sessionFiles.length === 0 ? (
                      <div className="sidebar-empty">No files yet</div>
                    ) : (
                      sessionFiles.map((f) => (
                        <div key={f.name} className="file-row" title={f.name}>
                          <span className="file-icon">{f.isDirectory ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}</span>
                          <span className="file-name">{f.name}</span>
                          <span className="file-size">{f.isDirectory ? "--" : formatFileSize(f.size)}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {sidebarCollapsed && (
            <div className="sidebar-collapsed-icons">
              <button type="button" className="icon-btn" onClick={createNewSession} title="New thread">+</button>
            </div>
          )}
        </aside>

        {/* ── Chat area ── */}
        <div className="chat-area">
          {/* Messages */}
          <div className="messages" ref={messagesRef}>
            {streamItems.length === 0 ? (
              <div className="empty-state">
                <p>Welcome to RovoDev Hub</p>
                <small>Start a thread and ask anything.</small>
              </div>
            ) : (
              <div className="messages-inner">
                {groupIntoTurns(streamItems).map((turn, ti) => {
                  if (turn.kind === "user") {
                    return (
                      <div className="msg msg-user" key={`turn-${ti}`}>
                        <div className="msg-label">You</div>
                        <div className="msg-bubble">{renderMarkdownText(turn.items[0].text)}</div>
                      </div>
                    );
                  }
                  return (
                    <div className="msg msg-assistant" key={`turn-${ti}`}>
                      <div className="msg-label">Rovo</div>
                      <div className="msg-bubble">
                        {turn.items.map((item, ii) => {
                          if (item.kind === "assistant") {
                            return <div key={`${item.id}-${ii}`}>{renderMarkdownText(item.text)}</div>;
                          }
                          return (
                            <details className="msg-inline-tool" key={`${item.id}-${ii}`}>
                              <summary className="msg-tool-summary">
                                <span className="msg-tool-icon">{item.kind === "tool" ? "\u2699" : "\u2022"}</span>
                                {extractToolLabel(item.text)}
                              </summary>
                              <pre className="msg-tool-body">{item.text}</pre>
                            </details>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {sending && streamItems.length > 0 && streamItems[streamItems.length - 1].kind === "user" && (
                  <div className="msg msg-assistant">
                    <div className="msg-label">Rovo</div>
                    <div className="msg-bubble thinking-indicator">
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="composer-wrapper">
            <form className="composer-box" onSubmit={sendChat}>
              <textarea
                ref={textareaRef}
                className="composer-textarea"
                rows={1}
                value={message}
                onChange={(e) => { setMessage(e.target.value); autoGrow(); }}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything..."
              />
              <div className="composer-bar">
                <div className="composer-segment">
                  {orderedModes.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={mode === opt ? "is-active" : ""}
                      onClick={() => updateMode(opt)}
                    >
                      {toTitleCase(opt)}
                    </button>
                  ))}
                </div>
                <select
                  className="composer-model"
                  value={model}
                  onChange={(e) => updateModel(e.target.value)}
                >
                  {normalizedModelOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.name}</option>
                  ))}
                </select>
                <span className="composer-spacer" />
                {sending ? (
                  <button type="button" className="stop-btn" onClick={stopStream} title="Stop">
                    <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>
                  </button>
                ) : (
                  <button type="submit" className="send-btn" disabled={!message.trim() || !activeSessionId} title="Send">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 12V4M4 7l4-4 4 4" />
                    </svg>
                  </button>
                )}
              </div>
            </form>
            <div className="composer-hint">
              <span>
                {activeSession
                  ? `${syncStatus || "Session active"}${streamPhase !== "idle" ? ` (${streamPhase})` : ""}`
                  : "Create or select a thread to start"}
              </span>
              <span>Enter to send, Shift+Enter for new line</span>
            </div>
            {error && <p className="error-text">{error}</p>}
          </div>
        </div>
      </div>

      {/* First-run onboarding */}
      {onboardingOpen && (
        <>
          <div className="drawer-overlay" onClick={() => setOnboardingOpen(false)} />
          <section className="onboarding-modal" role="dialog" aria-modal="true" aria-label="RovoDev Hub first-run setup">
            <h2>Welcome to RovoDev Hub</h2>
            {onboardingStep === 0 && (
              <div className="onboarding-step">
                <p>This is your setup wizard. One short run now, then no Terminal for daily use.</p>
                <ul>
                  <li>Authenticate your Atlassian account</li>
                  <li>Start the Rovo backend from the app</li>
                  <li>Create your first thread</li>
                </ul>
              </div>
            )}
            {onboardingStep === 1 && (
              <div className="onboarding-step">
                <p><strong>Step 1: Auth</strong></p>
                <p>
                  Status: {setupInfo?.auth.authenticated ? "Authenticated" : "Not authenticated"}
                </p>
                {!setupInfo?.auth.authenticated && (
                  <p className="onboarding-hint">
                    Run once in a terminal: <code>~/rovodev/bin/acli rovodev auth login</code>, then click re-check.
                  </p>
                )}
                <button
                  type="button"
                  className="drawer-btn"
                  onClick={() => settingsAction("auth-status")}
                  disabled={settingsLoading}
                >
                  Re-check auth
                </button>
              </div>
            )}
            {onboardingStep === 2 && (
              <div className="onboarding-step">
                <p><strong>Step 2: Backend</strong></p>
                <p>
                  Backend: {setupInfo?.backend.running ? `Running (PID ${setupInfo.backend.pid ?? "--"})` : "Stopped"}
                </p>
                <div className="onboarding-actions">
                  <button
                    type="button"
                    className="drawer-btn"
                    onClick={() => settingsAction("start-backend")}
                    disabled={settingsLoading}
                  >
                    Start backend
                  </button>
                  <button
                    type="button"
                    className="drawer-btn"
                    onClick={() => settingsAction("restart-backend")}
                    disabled={settingsLoading}
                  >
                    Restart backend
                  </button>
                </div>
              </div>
            )}
            {onboardingStep === 3 && (
              <div className="onboarding-step">
                <p><strong>Ready.</strong> Click below to start your first thread in the app.</p>
                <p className="onboarding-hint">
                  Promise target: click the RovoDev Hub icon in Dock/Desktop and work without Terminal after first run.
                </p>
              </div>
            )}
            <div className="onboarding-footer">
              <button
                type="button"
                className="drawer-btn"
                onClick={() => setOnboardingStep((s) => Math.max(0, s - 1))}
                disabled={onboardingStep === 0}
              >
                Back
              </button>
              {onboardingStep < 3 ? (
                <button
                  type="button"
                  className="drawer-btn"
                  onClick={() => {
                    if (onboardingStep === 0) {
                      if (setupPhase === "needs_auth") {
                        setOnboardingStep(1);
                        return;
                      }
                      if (setupPhase === "backend_offline") {
                        setOnboardingStep(2);
                        return;
                      }
                      if (setupPhase === "ready") {
                        setOnboardingStep(3);
                        return;
                      }
                    }
                    setOnboardingStep((s) => Math.min(3, s + 1));
                  }}
                  disabled={
                    setupPhase === "loading" ||
                    (onboardingStep === 1 && setupPhase === "needs_auth") ||
                    (onboardingStep === 2 && setupPhase !== "ready")
                  }
                >
                  Next
                </button>
              ) : (
                <button type="button" className="drawer-btn" onClick={finishOnboarding} disabled={setupPhase !== "ready"}>
                  Finish setup
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {/* Settings drawer */}
      {settingsOpen && (
        <>
          <div className="drawer-overlay" onClick={() => setSettingsOpen(false)} />
          <aside className="drawer">
            <div className="drawer-header">
              <h2>Settings</h2>
              <button type="button" className="icon-btn" onClick={() => setSettingsOpen(false)}>&times;</button>
            </div>
            <div className="drawer-body">
              {/* Account */}
              <section className="drawer-section">
                <h3>Account</h3>
                <div className="drawer-row">
                  <span className="drawer-label">User</span>
                  <span className="drawer-value">{status?.userLabel ?? "--"}</span>
                </div>
                <div className="drawer-row">
                  <span className="drawer-label">Site</span>
                  <span className="drawer-value">{sites.currentSite || "--"}</span>
                </div>
                {sites.availableSites.length > 1 && (
                  <div className="drawer-row">
                    <span className="drawer-label">Change site</span>
                    <select
                      className="drawer-select"
                      value={sites.currentSite}
                      onChange={(e) => settingsAction("set-site-url", { siteUrl: e.target.value })}
                    >
                      {sites.availableSites.map((s) => (
                        <option key={s} value={s}>{s.replace("https://", "")}</option>
                      ))}
                    </select>
                  </div>
                )}
              </section>

              {/* Backend */}
              <section className="drawer-section">
                <h3>Backend</h3>
                <div className="drawer-row">
                  <span className="drawer-label">Backend process</span>
                  <span className="drawer-value">
                    {setupInfo?.backend.running ? `Running (${setupInfo.backend.pid ?? "--"})` : "Stopped"}
                  </span>
                </div>
                <div className="drawer-row">
                  <span className="drawer-label">Status</span>
                  <span className={`drawer-value ${isHealthy ? "text-green" : "text-red"}`}>
                    {isHealthy ? "Healthy" : "Unreachable"}
                  </span>
                </div>
                <div className="drawer-row">
                  <span className="drawer-label">Model</span>
                  <span className="drawer-value">{status?.currentModelName ?? "--"}</span>
                </div>
                <div className="drawer-row">
                  <span className="drawer-label">Tools</span>
                  <span className="drawer-value">{status?.toolsCount ?? "--"}</span>
                </div>
                <div className="drawer-actions">
                  <button
                    type="button"
                    className="drawer-btn"
                    disabled={settingsLoading}
                    onClick={() => settingsAction("start-backend")}
                  >
                    Start Backend
                  </button>
                  <button
                    type="button"
                    className="drawer-btn"
                    disabled={settingsLoading}
                    onClick={() => settingsAction("stop-backend")}
                  >
                    Stop Backend
                  </button>
                  <button
                    type="button"
                    className="drawer-btn"
                    disabled={settingsLoading}
                    onClick={() => settingsAction("restart-backend")}
                  >
                    Restart Backend
                  </button>
                  <button
                    type="button"
                    className="drawer-btn"
                    disabled={settingsLoading}
                    onClick={() => settingsAction("reset")}
                  >
                    Reset Agent
                  </button>
                  <button
                    type="button"
                    className="drawer-btn"
                    disabled={settingsLoading}
                    onClick={() => settingsAction("clear")}
                  >
                    Clear Context
                  </button>
                  <button
                    type="button"
                    className="drawer-btn"
                    disabled={settingsLoading}
                    onClick={() => { settingsAction("cancel"); stopStream(); }}
                  >
                    Force Cancel
                  </button>
                </div>
              </section>

              {/* Auth */}
              <section className="drawer-section">
                <h3>Authentication</h3>
                <div className="drawer-row">
                  <span className="drawer-label">Auth status</span>
                  <span className={`drawer-value ${setupInfo?.auth.authenticated ? "text-green" : "text-red"}`}>
                    {setupInfo?.auth.authenticated ? "Authenticated" : "Needs login"}
                  </span>
                </div>
                <div className="drawer-actions">
                  <button
                    type="button"
                    className="drawer-btn"
                    disabled={settingsLoading}
                    onClick={() => settingsAction("auth-status")}
                  >
                    Re-check auth
                  </button>
                </div>
                <p className="drawer-hint">
                  If authentication expires, run in a terminal:
                </p>
                <pre className="drawer-code">~/rovodev/bin/acli rovodev auth login</pre>
                <p className="drawer-hint">
                  Then reload this page. The backend will pick up the refreshed credentials.
                </p>
              </section>

              {/* Info */}
              <section className="drawer-section">
                <h3>Info</h3>
                <div className="drawer-row">
                  <span className="drawer-label">Server version</span>
                  <span className="drawer-value">{status?.health?.version ?? "--"}</span>
                </div>
                <div className="drawer-row">
                  <span className="drawer-label">Account ID</span>
                  <span className="drawer-value drawer-mono">{status?.accountId ?? "--"}</span>
                </div>
              </section>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
