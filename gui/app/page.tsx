"use client";

import { FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionSummary, UiStatus } from "@/lib/types";

type StreamItem = {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "tool" | "system";
  text: string;
  meta?: {
    toolName?: string;
    toolStatus?: "running" | "done";
  };
};

type StreamPhase = "idle" | "sending" | "streaming" | "closing" | "done" | "error";

const DEFAULT_MODE_OPTIONS = ["default", "ask", "plan"];
const DEFAULT_MODEL_OPTIONS = [{ id: "default", name: "Auto" }];
const CHAT_STORE_KEY = "rovodev-chat-items-v1";
const RIGHT_RAIL_PREF_KEY = "rovodev-right-rail-pref-v1";
const MODE_ORDER = ["ask", "default", "plan"];
const QUICK_PROMPTS = [
  {
    icon: "📈",
    tag: "Market",
    title: "Market Landscape Brief",
    subtitle: "Internal signal + external scan",
    details: "Confluence, Jira, web, trend synthesis",
    prompt:
      "Act as a senior PMM analyst. Build a market landscape brief by combining (1) Confluence strategy/docs, (2) Jira execution and customer signal, and (3) current web research. Deliver: category map, top shifts, buyer pain hierarchy, and top 5 competitor moves from the last 2 quarters.",
  },
  {
    icon: "🧭",
    tag: "Positioning",
    title: "Parity vs Differentiation",
    subtitle: "Where we match vs where we win",
    details: "Feature matrix, claims, evidence",
    prompt:
      "Create a parity-versus-differentiation assessment against key competitors using our Jira/Confluence context plus external market evidence. Output: side-by-side matrix, proof-backed differentiators, areas to close, and final positioning narrative with do-not-claim guardrails.",
  },
  {
    icon: "🪄",
    tag: "Launch",
    title: "Launch Messaging Kit",
    subtitle: "Messaging architecture for PMMs",
    details: "ICP, narrative, channels, objections",
    prompt:
      "Draft a launch messaging kit from current internal product context: ICP definition, message hierarchy, value prop ladder, objection handling, and channel variants (web, email, sales enablement, social). Include 3 headline options and 1 battle-tested narrative arc.",
  },
  {
    icon: "⚔️",
    tag: "Competitive",
    title: "Competitive Battlecard",
    subtitle: "Field-ready talk tracks",
    details: "Win/loss themes, counters, traps",
    prompt:
      "Generate an actionable PMM battlecard combining internal win/loss context and external competitor intelligence. Include: competitor strengths/weaknesses, discovery trap questions, counter-positioning lines, and objection rebuttals for enterprise buyers.",
  },
  {
    icon: "📄",
    tag: "Exec PDF",
    title: "Exec PDF Report",
    subtitle: "Board-ready synthesis",
    details: "Insights, actions, risk, timeline",
    prompt:
      "Produce an executive-ready, beautifully formatted PDF report containing: market landscape, parity/differentiation matrix, messaging recommendation, key risks, and a 30-60-90 day PMM action plan with owners and success metrics.",
  },
];
const COMPOSER_PLACEHOLDERS = [
  "Ask anything...",
  "Run Jira + Confluence + web market analysis.",
  "Compare us vs competitors and show differentiation gaps.",
  "Spawn subagents and synthesize one decision memo.",
  "Turn this research into a polished PDF report.",
];

type RailItemState = "running" | "done" | "error";
type RailItemKind = "tool" | "subagent" | "system";
type RailMode = "auto" | "pinned" | "hidden";

type RailActivityItem = {
  id: string;
  label: string;
  detail: string;
  status: RailItemState;
  kind: RailItemKind;
  ts: string;
  runId: string;
  startedAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number;
  subagentId?: string;
  subagentName?: string;
  linkedStreamItemId?: string;
};

type RailTodoItem = {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
  linkedStreamItemId?: string;
};

type StreamUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextLimit: number;
};

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

function extractToolMeta(item: StreamItem): { toolName: string; status: "running" | "done" } | null {
  if (item.kind !== "tool") return null;
  if (item.meta?.toolName) {
    return {
      toolName: item.meta.toolName,
      status: item.meta.toolStatus ?? "done",
    };
  }
  const firstLine = item.text.split("\n")[0].trim();
  const called = firstLine.match(/^Called\s+(.+)$/i);
  if (called?.[1]) return { toolName: called[1].trim(), status: "running" };
  const returned = firstLine.match(/^(.+)\s+returned$/i);
  if (returned?.[1]) return { toolName: returned[1].trim(), status: "done" };
  return { toolName: extractToolLabel(item.text), status: "done" };
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

type FileEntry = {
  name: string;
  size: number;
  mtime: string;
  isDirectory: boolean;
  fullPath?: string;
  source?: "session" | "ingested";
};
type SitesInfo = { currentSite: string; availableSites: string[] };
type SetupInfo = {
  auth: { authenticated: boolean; detail: string };
  backend: { running: boolean; pid: number | null };
  apiPort: number;
  logFile: string;
};
type SetupPhase = "loading" | "needs_auth" | "backend_offline" | "ready";
type UiIssueKind = "auth" | "lock" | "stream" | null;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${String(sec).padStart(2, "0")}s`;
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
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [liveActivity, setLiveActivity] = useState("");
  const [rightRailMode, setRightRailMode] = useState<RailMode>("auto");
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [railActivity, setRailActivity] = useState<RailActivityItem[]>([]);
  const [railTodos, setRailTodos] = useState<RailTodoItem[]>([]);
  const [collapsedSubagents, setCollapsedSubagents] = useState<Record<string, boolean>>({});
  const [clockNowMs, setClockNowMs] = useState<number>(() => Date.now());
  const [streamUsage, setStreamUsage] = useState<StreamUsage | null>(null);
  const [streamStalled, setStreamStalled] = useState(false);
  const [uiIssueKind, setUiIssueKind] = useState<UiIssueKind>(null);
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
  const hasAssistantOutputRef = useRef<boolean>(false);
  const railRunningRef = useRef<number>(0);
  const railActivityByIdRef = useRef<Map<string, RailActivityItem>>(new Map());
  const railTodoByIdRef = useRef<Map<string, RailTodoItem>>(new Map());

  useEffect(() => { sendingRef.current = sending; }, [sending]);
  useEffect(() => {
    if (!error) return;
    const kind = deriveIssueKind(error);
    if (kind) setUiIssueKind(kind);
  }, [error]);

  function deriveIssueKind(text: string): UiIssueKind {
    const raw = text.toLowerCase();
    if (raw.includes("403") || raw.includes("401") || raw.includes("forbidden") || raw.includes("unauthorized")) {
      return "auth";
    }
    if (raw.includes("409") || raw.includes("chat in progress") || raw.includes("lock")) {
      return "lock";
    }
    if (raw.includes("stream") || raw.includes("timeout") || raw.includes("disconnect")) {
      return "stream";
    }
    return null;
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSidebarCollapsed(localStorage.getItem("rovodev-sidebar-collapsed") === "true");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(RIGHT_RAIL_PREF_KEY);
    if (saved === "auto" || saved === "pinned" || saved === "hidden") {
      setRightRailMode(saved);
      setRightRailOpen(saved === "pinned");
      return;
    }
    setRightRailMode("auto");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "rovodev-hub-onboarding-v1";
    const done = localStorage.getItem(key) === "done";
    setOnboardingPending(!done);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % COMPOSER_PLACEHOLDERS.length);
    }, 5000);
    return () => window.clearInterval(id);
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

  const applyRailActivity = useCallback((next: RailActivityItem) => {
    const existing = railActivityByIdRef.current.get(next.id);
    const now = Date.now();
    const merged: RailActivityItem = {
      ...next,
      startedAtMs: existing?.startedAtMs ?? next.startedAtMs ?? now,
      updatedAtMs: now,
      endedAtMs:
        next.status === "done" || next.status === "error"
          ? (existing?.endedAtMs ?? now)
          : undefined,
    };
    railActivityByIdRef.current.set(next.id, merged);
    const ordered = Array.from(railActivityByIdRef.current.values()).sort((a, b) => (
      a.startedAtMs - b.startedAtMs
    ));
    setRailActivity(ordered.slice(-80));
  }, []);

  const applyRailTodo = useCallback((next: RailTodoItem) => {
    railTodoByIdRef.current.set(next.id, next);
    const ordered = Array.from(railTodoByIdRef.current.values());
    const rank = (status: RailTodoItem["status"]) =>
      (status === "in_progress" ? 0 : status === "pending" ? 1 : 2);
    ordered.sort((a, b) => rank(a.status) - rank(b.status));
    setRailTodos(ordered.slice(0, 24));
  }, []);

  const clearRailState = useCallback(() => {
    railActivityByIdRef.current.clear();
    railTodoByIdRef.current.clear();
    setRailActivity([]);
    setRailTodos([]);
    setCollapsedSubagents({});
  }, []);

  const jumpToStreamItem = useCallback((streamItemId?: string) => {
    if (!streamItemId) return;
    const el = document.getElementById(`stream-item-${streamItemId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("is-highlight");
    window.setTimeout(() => el.classList.remove("is-highlight"), 1400);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(RIGHT_RAIL_PREF_KEY, rightRailMode);
  }, [rightRailMode]);

  useEffect(() => {
    if (rightRailMode === "pinned") {
      setRightRailOpen(true);
      return;
    }
    if (rightRailMode === "hidden") {
      setRightRailOpen(false);
      return;
    }
    const hasRunning = railActivity.some((item) => item.status === "running");
    if (sending || hasRunning) {
      setRightRailOpen(true);
    } else if (!sending && !hasRunning) {
      setRightRailOpen(false);
    }
  }, [rightRailMode, sending, railActivity]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "]") return;
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA") return;
      setRightRailOpen((prev) => !prev);
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!rightRailOpen && !sending) return;
    const id = window.setInterval(() => setClockNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [rightRailOpen, sending]);

  useEffect(() => {
    railRunningRef.current = railActivity.filter((item) => item.status === "running").length;
  }, [railActivity]);

  useEffect(() => {
    hasAssistantOutputRef.current = streamItems.some((item) => item.kind === "assistant" && item.text.trim().length > 0);
  }, [streamItems]);

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
  const railRunningCount = useMemo(
    () => railActivity.filter((item) => item.status === "running").length,
    [railActivity],
  );
  const railDoneCount = useMemo(
    () => railActivity.filter((item) => item.status === "done").length,
    [railActivity],
  );
  const railTotalCount = railActivity.length;
  const railProgressPct = railTotalCount > 0 ? Math.round((railDoneCount / railTotalCount) * 100) : 0;
  const toolUsageRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of railActivity) {
      if (item.kind !== "tool") continue;
      counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [railActivity]);
  const railStage = useMemo(() => {
    if (streamPhase === "error") return "Needs attention";
    if (sending && railRunningCount > 0) return "Executing tools and subagents";
    if (sending) return "Preparing workflow";
    if (streamPhase === "streaming") return "Writing response";
    if (streamPhase === "done") return "Completed";
    return "Idle";
  }, [streamPhase, sending, railRunningCount]);
  const issueChip = useMemo(() => {
    const kind = uiIssueKind;
    if (!kind) return null;
    if (kind === "auth") return { label: "Auth issue", tone: "auth" };
    if (kind === "lock") return { label: "Chat lock", tone: "lock" };
    return { label: "Stream issue", tone: "stream" };
  }, [uiIssueKind]);
  const railRunGroups = useMemo(() => {
    const grouped = new Map<string, RailActivityItem[]>();
    for (const item of railActivity) {
      const arr = grouped.get(item.runId) ?? [];
      arr.push(item);
      grouped.set(item.runId, arr);
    }
    const groups = Array.from(grouped.entries()).map(([runId, items]) => {
      const sorted = items.slice().sort((a, b) => a.startedAtMs - b.startedAtMs);
      const running = sorted.filter((item) => item.status === "running").length;
      const done = sorted.filter((item) => item.status === "done").length;
      const startedAtMs = sorted[0]?.startedAtMs ?? Date.now();
      const endedAtMs = sorted.every((i) => i.endedAtMs) ? Math.max(...sorted.map((i) => i.endedAtMs ?? startedAtMs)) : undefined;
      return { runId, items: sorted, running, done, startedAtMs, endedAtMs };
    });
    return groups.sort((a, b) => b.startedAtMs - a.startedAtMs);
  }, [railActivity]);
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
    clearRailState();
    setStreamUsage(null);
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
      const nextSessions = payload.sessions ?? [];
      setSessions(nextSessions);
      // Keep local cache aligned with authoritative backend session list.
      const store = readStore();
      const valid = new Set(nextSessions.map((s) => s.id));
      let storeChanged = false;
      for (const key of Object.keys(store)) {
        if (!valid.has(key)) {
          delete store[key];
          storeChanged = true;
        }
      }
      if (nextSessions.length === 0 && Object.keys(store).length > 0) {
        storeChanged = true;
      }
      if (storeChanged) {
        writeStore(store);
      }
      const currentId = activeSessionIdRef.current;
      if (nextSessions.length && !currentId) {
        selectSession(nextSessions[0].id);
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
      clearRailState();
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
    setStreamUsage(null);
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
    setLiveActivity("");
    setStreamUsage(null);
    setStreamStalled(false);
  }

  function markStreamStalled(note: string) {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setSending(false);
    setStreamPhase("error");
    setStreamStalled(true);
    setUiIssueKind("stream");
    markSyncStatus(note);
    setLiveActivity("Stream paused - click recover.");
  }

  async function recoverStream() {
    stopStream();
    markSyncStatus("Recovering stream lock...");
    await settingsAction("cancel");
    await loadStatus();
    setUiIssueKind(null);
    markSyncStatus("Recovered. Resend your prompt to continue.");
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

  function pickPrompt(text: string) {
    setMessage(text);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      autoGrow();
    });
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
    clearRailState();
    setStreamUsage(null);
    streamTokenRef.current = streamToken;
    streamRetryRef.current = 0;
    setStreamStalled(false);
    setUiIssueKind(null);
    setSending(true);
    setStreamPhase("sending");
    markSyncStatus("Preparing request...");
    setLiveActivity("Preparing task context...");
    assistantDraftIdRef.current = null;
    streamDoneRef.current = false;
    addStreamItem({ kind: "user", text });
    applyRailTodo({
      id: `todo:respond:${streamCorrelationId}`,
      text: "Produce final response",
      status: "in_progress",
    });

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
        code?: string;
        sync?: { sessionId: string; clientMessageId: string; streamCorrelationId: string };
      };
      if (!prepRes.ok) {
        throw new Error(prepBody.code ? `${prepBody.code}: ${prepBody.error ?? "Failed to set chat message"}` : (prepBody.error ?? "Failed to set chat message"));
      }
      logLifecycle("chat_prepare_sync", prepBody.sync);
      logLifecycle("chat_prepare_done", { selectedSessionId, streamCorrelationId });
    } catch (err) {
      const msg = (err as Error).message;
      setSending(false);
      setStreamPhase("error");
      markSyncStatus("Failed before stream start.");
      setLiveActivity("");
      setError(msg);
      setUiIssueKind(deriveIssueKind(msg) ?? "stream");
      logLifecycle("chat_prepare_error", { selectedSessionId, streamCorrelationId, message: msg });
      return;
    }

    const streamUrl = `/api/chat/stream?sessionId=${encodeURIComponent(selectedSessionId)}&yolo=${yolo}`;
    const toolItemByCallId = new Map<string, string>();
    const toolItemByName = new Map<string, string>();
    let activeSubagentContext: { id: string; name: string } | null = null;

    const upsertToolItem = (params: {
      callId?: string;
      toolName: string;
      text: string;
      status: "running" | "done";
      kind?: RailItemKind;
      todoText?: string;
      subagentId?: string;
      subagentName?: string;
    }) => {
      const callId = params.callId?.trim();
      let itemId = callId ? toolItemByCallId.get(callId) : undefined;
      if (!itemId) {
        itemId = toolItemByName.get(params.toolName);
      }
      if (itemId) {
        setStreamItems((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? { ...item, text: params.text, meta: { toolName: params.toolName, toolStatus: params.status } }
              : item,
          ),
        );
      } else {
        const created = addStreamItem({
          kind: "tool",
          text: params.text,
          meta: { toolName: params.toolName, toolStatus: params.status },
        });
        if (created) {
          itemId = created;
        }
      }
      if (itemId) {
        if (callId) toolItemByCallId.set(callId, itemId);
        toolItemByName.set(params.toolName, itemId);
        const activityId = `activity:${callId ?? params.toolName}`;
        applyRailActivity({
          id: activityId,
          label: params.toolName,
          detail: params.text,
          status: params.status,
          kind: params.kind ?? "tool",
          ts: new Date().toISOString(),
          runId: streamCorrelationId,
          startedAtMs: Date.now(),
          updatedAtMs: Date.now(),
          subagentId: params.subagentId,
          subagentName: params.subagentName,
          linkedStreamItemId: itemId,
        });
        applyRailTodo({
          id: `todo:${callId ?? params.toolName}`,
          text: params.todoText ?? `Run ${params.toolName}`,
          status: params.status === "running" ? "in_progress" : "completed",
          linkedStreamItemId: itemId,
        });
      }
    };

    const resolveToolCallId = (
      parsed: Record<string, unknown> | null,
      part: Record<string, unknown>,
      toolName: string,
      eventName: string,
    ) => {
      const candidates = [
        part.tool_call_id,
        part.call_id,
        part.id,
        parsed?.tool_call_id,
        parsed?.call_id,
        parsed?.id,
      ];
      const found = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
      if (typeof found === "string") return found;
      return `${eventName}:${toolName}`;
    };

    const readStringField = (obj: Record<string, unknown>, keys: string[]): string | null => {
      for (const key of keys) {
        const value = obj[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
      return null;
    };

    const normalizeEventName = (eventName: string): string => eventName.replace(/_/g, "-").toLowerCase();

    const parseSubagentEvent = (
      parsed: Record<string, unknown> | null,
      eventName: string,
    ): { event: "start" | "end" | null; id: string; name: string; detail: string } | null => {
      if (!parsed) return null;
      const normalized = normalizeEventName(eventName);
      const isStart = normalized === "agent-start" || normalized === "subagent-start";
      const isEnd = normalized === "agent-end" || normalized === "subagent-end";
      if (!isStart && !isEnd) return null;

      const maybePayload =
        parsed.payload && typeof parsed.payload === "object"
          ? (parsed.payload as Record<string, unknown>)
          : parsed;

      const rawName =
        readStringField(maybePayload, ["subagent_name", "agent_name", "name", "title", "description"]) ??
        "Subagent";
      const rawId =
        readStringField(maybePayload, ["subagent_id", "agent_id", "id", "run_id", "execution_id"]) ??
        rawName.toLowerCase();
      const detail = clipText(safeStringify(maybePayload), isStart ? 420 : 560);

      return {
        event: isStart ? "start" : "end",
        id: rawId,
        name: rawName,
        detail,
      };
    };
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
      setLiveActivity(isClean ? "Done." : "");
      applyRailTodo({
        id: `todo:respond:${streamCorrelationId}`,
        text: "Produce final response",
        status: isClean ? "completed" : "pending",
      });
      logLifecycle("stream_finalize", { selectedSessionId, streamCorrelationId, isClean, note });
      loadSessionFiles(selectedSessionId);
    };

    const attachStream = (stream: EventSource) => {
      eventSourceRef.current = stream;
      lastStreamActivityRef.current = Date.now();

      const processStreamEvent = (eventName: string, parsed: Record<string, unknown> | null, raw: string): boolean => {
        const subagent = parseSubagentEvent(parsed, eventName);
        if (subagent) {
          const toolName = `Subagent · ${subagent.name}`;
          if (subagent.event === "start") {
            activeSubagentContext = { id: subagent.id, name: subagent.name };
            setLiveActivity(`${toolName} started...`);
            upsertToolItem({
              callId: `subagent:${subagent.id}`,
              toolName,
              text: `Started ${toolName}\n${subagent.detail}`,
              status: "running",
              kind: "subagent",
              todoText: `Wait for ${subagent.name} to finish`,
              subagentId: subagent.id,
              subagentName: subagent.name,
            });
          } else {
            if (activeSubagentContext?.id === subagent.id) {
              activeSubagentContext = null;
            }
            setLiveActivity(`${toolName} complete`);
            upsertToolItem({
              callId: `subagent:${subagent.id}`,
              toolName,
              text: `${toolName} complete\n${subagent.detail}`,
              status: "done",
              kind: "subagent",
              todoText: `Wait for ${subagent.name} to finish`,
              subagentId: subagent.id,
              subagentName: subagent.name,
            });
          }
          return true;
        }

        if (eventName === "text") {
          setStreamPhase("streaming");
          markSyncStatus("Streaming response...");
          setLiveActivity("Writing response...");
          appendAssistantChunk(parsed?.content ? String(parsed.content) : String(raw));
          return true;
        }
        if (eventName === "tool-call" || eventName === "tool_call") {
          const toolName = String(parsed?.tool_name ?? "tool");
          const args = safeStringify(parsed?.args ?? {});
          const callId = typeof parsed?.tool_call_id === "string" ? parsed.tool_call_id : undefined;
          setLiveActivity(`Running ${toolName}...`);
          upsertToolItem({
            callId,
            toolName,
            text: `Called ${toolName}\n${clipText(args, 400)}`,
            status: "running",
            kind: "tool",
            todoText: `Run ${toolName}`,
            subagentId: activeSubagentContext?.id,
            subagentName: activeSubagentContext?.name,
          });
          return true;
        }
        if (eventName === "tool-return" || eventName === "tool_return") {
          const toolName = String(parsed?.tool_name ?? "tool");
          const result = safeStringify(parsed?.content ?? parsed ?? raw);
          const callId = typeof parsed?.tool_call_id === "string" ? parsed.tool_call_id : undefined;
          setLiveActivity(`${toolName} complete`);
          upsertToolItem({
            callId,
            toolName,
            text: `${toolName} returned\n${clipText(result, 600)}`,
            status: "done",
            kind: "tool",
            todoText: `Run ${toolName}`,
            subagentId: activeSubagentContext?.id,
            subagentName: activeSubagentContext?.name,
          });
          return true;
        }
        if (eventName === "part_start" || eventName === "part_delta") {
          const delta = parsed?.delta && typeof parsed.delta === "object" ? (parsed.delta as Record<string, unknown>) : {};
          const part = parsed?.part && typeof parsed.part === "object" ? (parsed.part as Record<string, unknown>) : {};
          const partKindRaw =
            (typeof part.part_kind === "string" && part.part_kind) ||
            (typeof parsed?.part_kind === "string" && parsed.part_kind) ||
            "";
          const partKind = partKindRaw.replace(/_/g, "-");
          if (partKind === "tool-call") {
            const toolName = String(part.tool_name ?? parsed?.tool_name ?? "tool");
            const args = safeStringify(part.args ?? parsed?.args ?? part.content ?? {});
            setLiveActivity(`Running ${toolName}...`);
            upsertToolItem({
              callId: resolveToolCallId(parsed, part, toolName, "tool-call"),
              toolName,
              text: `Called ${toolName}\n${clipText(args, 400)}`,
              status: "running",
              kind: "tool",
              todoText: `Run ${toolName}`,
              subagentId: activeSubagentContext?.id,
              subagentName: activeSubagentContext?.name,
            });
            return true;
          }
          if (partKind === "tool-return") {
            const toolName = String(part.tool_name ?? parsed?.tool_name ?? "tool");
            const resultValue =
              part.content !== undefined
                ? part.content
                : delta.content_delta !== undefined
                  ? delta.content_delta
                  : parsed?.content;
            const result = safeStringify(resultValue ?? {});
            setLiveActivity(`${toolName} complete`);
            upsertToolItem({
              callId: resolveToolCallId(parsed, part, toolName, "tool-return"),
              toolName,
              text: `${toolName} returned\n${clipText(result, 600)}`,
              status: "done",
              kind: "tool",
              todoText: `Run ${toolName}`,
              subagentId: activeSubagentContext?.id,
              subagentName: activeSubagentContext?.name,
            });
            return true;
          }

          const content =
            typeof part.content === "string"
              ? part.content
              : typeof delta.content_delta === "string"
                ? delta.content_delta
                : "";
          if (content) {
            setStreamPhase("streaming");
            markSyncStatus("Streaming response...");
            setLiveActivity("Writing response...");
            appendAssistantChunk(content);
            return true;
          }
        }
        if (eventName === "error") {
          setLiveActivity("Encountered an error event.");
          addStreamItem({ kind: "system", text: clipText(safeStringify(parsed ?? raw)) });
          return true;
        }
        return false;
      };

      const eventNames = [
        "text",
        "tool-call",
        "tool-return",
        "tool_call",
        "tool_return",
        "part_start",
        "part_delta",
        "agent_start",
        "agent_end",
        "subagent_start",
        "subagent_end",
        "error",
      ];
      for (const eventName of eventNames) {
        stream.addEventListener(eventName, ((ev: MessageEvent) => {
          if (streamTokenRef.current !== streamToken || activeSessionIdRef.current !== selectedSessionId) return;
          lastStreamActivityRef.current = Date.now();
          const raw = ev.data;
          const parsed = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })();
          processStreamEvent(eventName, parsed, raw);
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
      stream.addEventListener("request-usage", ((ev: MessageEvent) => {
        if (streamTokenRef.current !== streamToken) return;
        const raw = ev.data;
        const parsed = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })();
        if (!parsed) return;
        setStreamUsage({
          inputTokens: typeof parsed.input_tokens === "number" ? parsed.input_tokens : 0,
          outputTokens: typeof parsed.output_tokens === "number" ? parsed.output_tokens : 0,
          cacheReadTokens: typeof parsed.cache_read_tokens === "number" ? parsed.cache_read_tokens : 0,
          cacheWriteTokens: typeof parsed.cache_write_tokens === "number" ? parsed.cache_write_tokens : 0,
          contextLimit: typeof parsed.context_limit === "number" ? parsed.context_limit : 0,
        });
      }) as EventListener);

      const suppressedEvents = new Set([
        "run_start", "run_end", "agent_start", "agent_end",
        "part_start", "part_delta", "part_end",
        "model_request_start", "model_request_end",
        "text", "tool_call", "tool_return", "tool-call", "tool-return",
        "subagent_start", "subagent_end",
        "user-prompt", "request-usage", "close", "on_call_tools_start",
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
        if (marker === "run_end") {
          streamDoneRef.current = true;
          // Some backends emit end markers before closing the stream.
          // Give a brief grace window for final text chunks, then finalize if still open.
          window.setTimeout(() => {
            if (streamTokenRef.current !== streamToken) return;
            if (!sendingRef.current) return;
            finalizeStream(true, "Synced with backend.");
          }, 1500);
          return;
        }
        if (processStreamEvent(marker, parsed, raw)) return;
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
        setUiIssueKind("stream");
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
      if (!sendingRef.current) return;
      const idleMs = Date.now() - lastStreamActivityRef.current;
      if (idleMs > 90000 && railRunningRef.current === 0) {
        markStreamStalled(
          hasAssistantOutputRef.current
            ? "Stream stalled after partial output."
            : "Stream stalled before output.",
        );
        return;
      }
      if (idleMs > 120000) {
        setLiveActivity("Still working... running longer task");
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
          <button
            type="button"
            className={rightRailOpen ? "toggle-pill is-on" : "toggle-pill"}
            onClick={() => {
              if (rightRailMode === "hidden") {
                setRightRailMode("auto");
              }
              setRightRailOpen((prev) => !prev);
            }}
            title="Toggle activity rail ]"
          >
            Activity
            {railRunningCount > 0 ? <span className="topbar-rail-count">{railRunningCount}</span> : null}
          </button>
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
                        <div
                          key={f.fullPath ?? f.name}
                          className={f.source === "ingested" ? "file-row is-ingested" : "file-row"}
                          title={f.fullPath ?? f.name}
                          onClick={() => {
                            if (!f.fullPath || f.isDirectory) return;
                            window.open(`vscode://file${f.fullPath}`, "_blank");
                          }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && f.fullPath && !f.isDirectory) {
                              window.open(`vscode://file${f.fullPath}`, "_blank");
                            }
                          }}
                        >
                          <span className="file-icon">{f.isDirectory ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}</span>
                          <span className="file-name">{f.name}</span>
                          {f.source === "ingested" && <span className="file-src-badge">ingested</span>}
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
                <span className="empty-actions-label">Try one PMM power workflow</span>
                <div className="empty-actions">
                  {QUICK_PROMPTS.map((item) => (
                    <button key={item.title} type="button" className="empty-action-btn" onClick={() => pickPrompt(item.prompt)}>
                      <span className="empty-action-tag">{item.tag}</span>
                      <span className="empty-action-icon" aria-hidden="true">{item.icon}</span>
                      <span className="empty-action-copy">
                        <span className="empty-action-title">{item.title}</span>
                        <span className="empty-action-subtitle">{item.subtitle}</span>
                        <span className="empty-action-details">{item.details}</span>
                      </span>
                    </button>
                  ))}
                </div>
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
                  const thinkingItems = turn.items.filter((item) => item.kind !== "assistant");
                  const deliverableItems = turn.items.filter((item) => item.kind === "assistant");
                  return (
                    <div className="msg msg-assistant" key={`turn-${ti}`}>
                      <div className="msg-label">Rovo</div>
                      <div className="msg-bubble">
                        {thinkingItems.length > 0 && (
                          <div className="msg-phase msg-phase-thinking">
                            <div className="msg-phase-title">Thinking</div>
                            {thinkingItems.map((item, ii) => {
                              const toolMeta = extractToolMeta(item);
                              return (
                                <details
                                  className={toolMeta?.status === "running" ? "msg-inline-tool is-running" : "msg-inline-tool is-done"}
                                  id={`stream-item-${item.id}`}
                                  key={`${item.id}-${ii}`}
                                >
                                  <summary className="msg-tool-summary">
                                    <span className={`msg-tool-state ${toolMeta?.status === "running" ? "is-running" : "is-done"}`}>
                                      {toolMeta?.status === "running" ? "Running" : "Complete"}
                                    </span>
                                    <span className="msg-tool-name">{toolMeta?.toolName ?? extractToolLabel(item.text)}</span>
                                  </summary>
                                  <pre className="msg-tool-body">{item.text}</pre>
                                </details>
                              );
                            })}
                          </div>
                        )}
                        {deliverableItems.length > 0 && (
                          <div className="msg-phase msg-phase-deliverable">
                            <div className="msg-phase-title">Deliverable</div>
                            {deliverableItems.map((item, ii) => (
                              <div key={`${item.id}-${ii}`}>{renderMarkdownText(item.text)}</div>
                            ))}
                          </div>
                        )}
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
                placeholder={COMPOSER_PLACEHOLDERS[placeholderIndex]}
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
              {issueChip ? <span className={`sync-chip sync-chip-${issueChip.tone}`}>{issueChip.label}</span> : null}
              <span>
                {activeSession
                  ? (
                    syncStatus ||
                    (streamPhase === "sending"
                      ? "Warming up Rovo..."
                      : streamPhase === "streaming"
                        ? "Rovo is thinking..."
                        : streamPhase === "closing"
                          ? "Wrapping up..."
                          : streamPhase === "done"
                            ? "Done. Ready for your next move."
                            : streamPhase === "error"
                              ? "Hit a bump. Try again."
                              : "Session active")
                  )
                  : "Create or select a thread to start"}
              </span>
              <span>{sending ? (liveActivity || "Working...") : "Enter to send, Shift+Enter for new line"}</span>
              {streamStalled ? (
                <button type="button" className="recover-btn" onClick={recoverStream}>
                  Recover stream
                </button>
              ) : null}
            </div>
            {error && <p className="error-text">{error}</p>}
          </div>
        </div>
        {(rightRailMode !== "hidden" || rightRailOpen) && (
          <aside className={rightRailOpen ? "right-rail is-open" : "right-rail"}>
            <div className="right-rail-header">
              <div className="right-rail-title">
                <strong>Orchestration</strong>
                {railRunningCount > 0 ? <span className="right-rail-live">{railRunningCount} running</span> : null}
              </div>
              <div className="right-rail-actions">
                <button
                  type="button"
                  className={rightRailMode === "auto" ? "rail-chip is-active" : "rail-chip"}
                  onClick={() => setRightRailMode("auto")}
                  title="Auto open while active"
                >
                  Auto
                </button>
                <button
                  type="button"
                  className={rightRailMode === "pinned" ? "rail-chip is-active" : "rail-chip"}
                  onClick={() => { setRightRailMode("pinned"); setRightRailOpen(true); }}
                  title="Keep open"
                >
                  Pin
                </button>
                <button
                  type="button"
                  className={rightRailMode === "hidden" ? "rail-chip is-active" : "rail-chip"}
                  onClick={() => { setRightRailMode("hidden"); setRightRailOpen(false); }}
                  title="Hide rail"
                >
                  Hide
                </button>
              </div>
            </div>

            <section className="rail-section">
              <div className="rail-section-top">
                <span>Progress</span>
                <small>{railDoneCount}/{railTotalCount} complete</small>
              </div>
              <div className="rail-progress-track">
                <span style={{ width: `${railProgressPct}%` }} />
              </div>
              <p className="rail-stage">{railStage}</p>
            </section>

            <section className="rail-section">
              <div className="rail-section-top">
                <span>Usage</span>
                <small>{toolUsageRows.length} tools</small>
              </div>
              {streamUsage && (
                <div className="rail-usage-grid">
                  <span>Input</span><strong>{streamUsage.inputTokens.toLocaleString()}</strong>
                  <span>Output</span><strong>{streamUsage.outputTokens.toLocaleString()}</strong>
                  <span>Cache R/W</span><strong>{streamUsage.cacheReadTokens.toLocaleString()} / {streamUsage.cacheWriteTokens.toLocaleString()}</strong>
                  <span>Context</span><strong>{streamUsage.contextLimit > 0 ? streamUsage.contextLimit.toLocaleString() : "--"}</strong>
                </div>
              )}
              {toolUsageRows.length === 0 ? (
                <p className="rail-empty">Tool usage appears after first call.</p>
              ) : (
                <div className="rail-usage-tools">
                  {toolUsageRows.map((row) => (
                    <div key={row.name} className="rail-usage-tool-row">
                      <span>{row.name}</span>
                      <strong>{row.count}</strong>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rail-section">
              <div className="rail-section-top">
                <span>Agent runs</span>
                <small>{railRunGroups.length}</small>
              </div>
              {railRunGroups.length === 0 ? (
                <p className="rail-empty">No live activity yet.</p>
              ) : (
                <div className="rail-list rail-list-activity">
                  {railRunGroups.map((run, runIdx) => {
                    const subagentRoots = run.items.filter((item) => item.kind === "subagent");
                    const topLevel = run.items.filter((item) => item.kind !== "subagent" && !item.subagentId);
                    const runElapsed = formatElapsed((run.endedAtMs ?? clockNowMs) - run.startedAtMs);
                    return (
                      <details key={run.runId} className="rail-run-group" open={runIdx === 0 || run.running > 0}>
                        <summary className="rail-run-summary">
                          <span className="rail-run-left">
                            <span className={`rail-row-state is-${run.running > 0 ? "running" : "done"}`}>
                              {run.running > 0 ? "Running" : "Complete"}
                            </span>
                            <span className="rail-run-label">Run {runIdx + 1}</span>
                          </span>
                          <span className="rail-run-right">
                            <span>{run.done}/{run.items.length}</span>
                            <span>{runElapsed}</span>
                          </span>
                        </summary>

                        {topLevel.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            className="rail-row"
                            onClick={() => jumpToStreamItem(item.linkedStreamItemId)}
                          >
                            <span className={`rail-row-state is-${item.status}`}>{item.status === "running" ? "Running" : item.status === "done" ? "Complete" : "Error"}</span>
                            <span className="rail-row-main">
                              <span className="rail-row-title">{item.label}</span>
                              <span className="rail-row-meta">{formatElapsed((item.endedAtMs ?? clockNowMs) - item.startedAtMs)}</span>
                            </span>
                          </button>
                        ))}

                        {subagentRoots.map((subagent) => {
                          const sid = subagent.subagentId ?? subagent.id;
                          const children = run.items.filter((item) => item.subagentId === sid && item.kind !== "subagent");
                          const collapsed = collapsedSubagents[sid] ?? false;
                          return (
                            <div key={subagent.id} className="rail-subagent-group">
                              <button
                                type="button"
                                className="rail-subagent-toggle"
                                onClick={() => setCollapsedSubagents((prev) => ({ ...prev, [sid]: !collapsed }))}
                              >
                                <span className="rail-subagent-chev">{collapsed ? "▸" : "▾"}</span>
                                <span className={`rail-row-state is-${subagent.status}`}>{subagent.status === "running" ? "Running" : "Complete"}</span>
                                <span className="rail-subagent-title">{subagent.label}</span>
                                <span className="rail-subagent-time">{formatElapsed((subagent.endedAtMs ?? clockNowMs) - subagent.startedAtMs)}</span>
                              </button>
                              {!collapsed && (
                                <div className="rail-subagent-children">
                                  {children.length === 0 ? (
                                    <p className="rail-empty">Waiting for first step...</p>
                                  ) : (
                                    children.map((child) => (
                                      <button
                                        key={child.id}
                                        type="button"
                                        className="rail-row rail-row-child"
                                        onClick={() => jumpToStreamItem(child.linkedStreamItemId)}
                                      >
                                        <span className={`rail-row-state is-${child.status}`}>{child.status === "running" ? "Running" : "Complete"}</span>
                                        <span className="rail-row-main">
                                          <span className="rail-row-title">{child.label}</span>
                                          <span className="rail-row-meta">{formatElapsed((child.endedAtMs ?? clockNowMs) - child.startedAtMs)}</span>
                                        </span>
                                      </button>
                                    ))
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </details>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="rail-section">
              <div className="rail-section-top">
                <span>Todos</span>
                <small>{railTodos.filter((t) => t.status === "completed").length}/{railTodos.length}</small>
              </div>
              {railTodos.length === 0 ? (
                <p className="rail-empty">Todo list appears as work unfolds.</p>
              ) : (
                <div className="rail-list rail-list-todos">
                  {railTodos.map((todo) => (
                    <button
                      key={todo.id}
                      type="button"
                      className="rail-row rail-todo-row"
                      onClick={() => jumpToStreamItem(todo.linkedStreamItemId)}
                    >
                      <span className={`rail-todo-check is-${todo.status}`} aria-hidden="true">
                        {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : "○"}
                      </span>
                      <span className="rail-todo-text">{todo.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </aside>
        )}
        {!rightRailOpen && rightRailMode !== "hidden" && railRunningCount > 0 && (
          <button
            type="button"
            className="right-rail-peek"
            onClick={() => setRightRailOpen(true)}
            title="Open activity rail"
          >
            {railRunningCount} running
          </button>
        )}
      </div>

      {/* First-run onboarding */}
      {onboardingOpen && (
        <>
          <div className="drawer-overlay" onClick={() => setOnboardingOpen(false)} />
          <section className="onboarding-modal" role="dialog" aria-modal="true" aria-label="RovoDev Hub first-run setup">
            <div className="onboarding-top">
              <h2>Welcome to RovoDev Hub</h2>
              <span className="onboarding-step-pill">Step {onboardingStep + 1} of 4</span>
            </div>
            <div className="onboarding-progress" aria-hidden="true">
              {[0, 1, 2, 3].map((idx) => (
                <span key={idx} className={idx <= onboardingStep ? "is-active" : ""} />
              ))}
            </div>
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
                <p><strong>Ready.</strong> Click below to start your first thread in the app. You are all set.</p>
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
