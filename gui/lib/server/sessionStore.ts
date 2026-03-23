import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = path.join(process.env.HOME ?? "", "rovodev", "workspace");
const sessionsRoot = path.join(workspaceRoot, "sessions");
const storePath = path.join(process.env.HOME ?? "", "rovodev", "session-folders.json");

type SessionMap = Record<string, string>;

async function readStore(): Promise<SessionMap> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as SessionMap;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeStore(map: SessionMap): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(map, null, 2), "utf8");
}

export async function ensureSessionFolder(sessionId: string): Promise<string> {
  if (!sessionId.trim()) {
    throw new Error("Session id cannot be empty");
  }
  const map = await readStore();
  const existing = map[sessionId];
  if (existing) {
    await fs.mkdir(existing, { recursive: true });
    return existing;
  }

  const sessionFolder = path.join(sessionsRoot, sessionId);
  await fs.mkdir(sessionFolder, { recursive: true });
  map[sessionId] = sessionFolder;
  await writeStore(map);
  return sessionFolder;
}

export async function getSessionFolder(sessionId: string): Promise<string | null> {
  const map = await readStore();
  const folder = map[sessionId];
  if (!folder) {
    return null;
  }
  try {
    await fs.mkdir(folder, { recursive: true });
    return folder;
  } catch {
    return null;
  }
}

export async function withSessionFolder(sessionId: string): Promise<string> {
  const folder = await getSessionFolder(sessionId);
  if (!folder) {
    throw new Error(`No folder mapping exists for session ${sessionId}`);
  }
  return folder;
}
