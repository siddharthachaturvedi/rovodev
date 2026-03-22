import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  cancelChat,
  clearAgent,
  fetchHealth,
  fetchRuntimeStatus,
  fetchSites,
  resetAgent,
  setSiteUrl,
  shutdownServer,
} from "@/lib/server/rovodev";

const execFileAsync = promisify(execFile);
const ROVODEV_HOME = path.join(os.homedir(), "rovodev");
const ACLI_BIN = path.join(ROVODEV_HOME, "bin", "acli");
const GUI_BACKEND_PID_FILE = path.join(ROVODEV_HOME, "gui-backend.pid");
const GUI_BACKEND_LOG_FILE = path.join(ROVODEV_HOME, "gui-backend.log");
const SITE_URL = process.env.ROVODEV_SITE_URL ?? "https://hello.atlassian.net";
const API_PORT = Number(process.env.ROVODEV_API_PORT ?? "8123");

type BackendControlStatus = "started" | "already_running" | "stopped" | "not_running";

async function readBackendPid(): Promise<number | null> {
  try {
    const raw = (await fsp.readFile(GUI_BACKEND_PID_FILE, "utf8")).trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function backendState(): Promise<{ running: boolean; pid: number | null }> {
  const pid = await readBackendPid();
  if (!pid) {
    return { running: false, pid: null };
  }
  return { running: isPidAlive(pid), pid: isPidAlive(pid) ? pid : null };
}

async function getAuthStatus(): Promise<{ authenticated: boolean; detail: string }> {
  if (!fs.existsSync(ACLI_BIN)) {
    return { authenticated: false, detail: `acli not found at ${ACLI_BIN}` };
  }
  try {
    await execFileAsync(ACLI_BIN, ["rovodev", "auth", "status"], { timeout: 10000 });
    return { authenticated: true, detail: "Authenticated" };
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: string }).stderr ?? "").trim()
        : "Not authenticated";
    return { authenticated: false, detail: detail || "Not authenticated" };
  }
}

async function startBackend(): Promise<{ status: BackendControlStatus; message: string; pid?: number }> {
  await fsp.mkdir(ROVODEV_HOME, { recursive: true });
  const health = await fetchHealth().catch(() => null);
  if (health?.status === "healthy") {
    return { status: "already_running", message: "Backend already reachable on API port" };
  }
  const current = await backendState();
  if (current.running && current.pid) {
    return { status: "already_running", message: `Backend already running (PID ${current.pid})`, pid: current.pid };
  }
  if (!fs.existsSync(ACLI_BIN)) {
    throw new Error(`acli not found at ${ACLI_BIN}`);
  }

  const outFd = fs.openSync(GUI_BACKEND_LOG_FILE, "a");
  const child = spawn(
    ACLI_BIN,
    ["rovodev", "serve", String(API_PORT), "--site-url", SITE_URL, "--disable-session-token"],
    {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: process.env,
    }
  );
  child.unref();
  fs.closeSync(outFd);

  await fsp.writeFile(GUI_BACKEND_PID_FILE, String(child.pid), "utf8");
  return { status: "started", message: `Backend started (PID ${child.pid})`, pid: child.pid };
}

async function stopBackend(): Promise<{ status: BackendControlStatus; message: string }> {
  const current = await backendState();
  if (!current.running || !current.pid) {
    return { status: "not_running", message: "Backend is not running" };
  }
  try {
    process.kill(current.pid, "SIGTERM");
  } catch {
    // Best effort.
  }
  try {
    await fsp.unlink(GUI_BACKEND_PID_FILE);
  } catch {
    // No-op.
  }
  return { status: "stopped", message: `Backend stop signal sent (PID ${current.pid})` };
}

export async function GET() {
  try {
    const [runtime, sites, health, auth, backend] = await Promise.all([
      fetchRuntimeStatus().catch(() => null),
      fetchSites().catch(() => ({ currentSite: "", availableSites: [] })),
      fetchHealth().catch(() => null),
      getAuthStatus(),
      backendState(),
    ]);
    return NextResponse.json({
      ok: true,
      runtime,
      sites,
      health,
      setup: {
        auth,
        backend: {
          running: backend.running || health?.status === "healthy",
          pid: backend.pid,
        },
        apiPort: API_PORT,
        logFile: GUI_BACKEND_LOG_FILE,
      },
      serverVersion: health?.version ?? null,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { action: string; siteUrl?: string };
    switch (body.action) {
      case "reset":
        await resetAgent();
        return NextResponse.json({ ok: true, message: "Agent reset successfully" });
      case "clear":
        await clearAgent();
        return NextResponse.json({ ok: true, message: "Agent context cleared" });
      case "cancel":
        await cancelChat();
        return NextResponse.json({ ok: true, message: "Chat cancelled" });
      case "set-site-url":
        if (!body.siteUrl) {
          return NextResponse.json({ error: "siteUrl is required" }, { status: 400 });
        }
        await setSiteUrl(body.siteUrl);
        return NextResponse.json({ ok: true, message: `Site set to ${body.siteUrl}` });
      case "shutdown":
        await shutdownServer();
        return NextResponse.json({ ok: true, message: "Shutdown signal sent" });
      case "auth-status": {
        const auth = await getAuthStatus();
        return NextResponse.json({ ok: true, auth });
      }
      case "start-backend": {
        const started = await startBackend();
        return NextResponse.json({ ok: true, backend: started });
      }
      case "stop-backend": {
        const stopped = await stopBackend();
        return NextResponse.json({ ok: true, backend: stopped });
      }
      case "restart-backend": {
        await stopBackend();
        const restarted = await startBackend();
        return NextResponse.json({ ok: true, backend: restarted });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
