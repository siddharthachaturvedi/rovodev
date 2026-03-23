import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = path.join(process.env.HOME ?? "", "rovodev", "workspace");
const sessionsRoot = path.join(workspaceRoot, "sessions");
const archiveRoot = path.join(workspaceRoot, "sessions-archive");
const storePath = path.join(process.env.HOME ?? "", "rovodev", "session-folders.json");
const rovoSessionsRoot = path.join(process.env.HOME ?? "", ".rovodev", "sessions");
const ingestManifestName = ".ingested-artifacts.json";
const artifactExtensions = new Set([".md", ".pdf", ".docx", ".pptx", ".txt", ".csv", ".json", ".xlsx"]);

type SessionMap = Record<string, string>;
type IngestManifest = Record<string, { sourcePath: string; ingestedAt: string }>;
let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<SessionMap> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return normalizeMap(parsed as SessionMap);
    }
    return {};
  } catch {
    return {};
  }
}

async function writeStore(map: SessionMap): Promise<void> {
  const normalized = normalizeMap(map);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(normalized, null, 2), "utf8");
}

async function withStoreWriteLock<T>(fn: (map: SessionMap) => Promise<T>): Promise<T> {
  const run = writeQueue.then(async () => {
    const map = await readStore();
    const result = await fn(map);
    await writeStore(map);
    return result;
  });
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function canonicalFolder(sessionId: string): string {
  return path.join(sessionsRoot, sessionId);
}

function normalizeMap(map: SessionMap): SessionMap {
  const next: SessionMap = {};
  for (const [sessionId, folder] of Object.entries(map)) {
    if (!sessionId) continue;
    if (typeof folder !== "string" || !folder.trim()) {
      next[sessionId] = canonicalFolder(sessionId);
      continue;
    }
    next[sessionId] = path.isAbsolute(folder) ? folder : canonicalFolder(sessionId);
  }
  return next;
}

export async function ensureSessionFolder(sessionId: string): Promise<string> {
  if (!sessionId.trim()) {
    throw new Error("Session id cannot be empty");
  }
  return withStoreWriteLock(async (map) => {
    const existing = map[sessionId];
    if (existing) {
      await fs.mkdir(existing, { recursive: true });
      return existing;
    }
    const sessionFolder = canonicalFolder(sessionId);
    await fs.mkdir(sessionFolder, { recursive: true });
    map[sessionId] = sessionFolder;
    return sessionFolder;
  });
}

export async function getSessionFolder(sessionId: string): Promise<string | null> {
  if (!sessionId.trim()) return null;
  const folder = await withStoreWriteLock(async (map) => {
    const existing = map[sessionId];
    if (!existing) return null;
    if (!path.isAbsolute(existing)) {
      map[sessionId] = canonicalFolder(sessionId);
    }
    return map[sessionId];
  });
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

export async function cleanupSessionFolderMapping(
  sessionId: string,
  options?: { archiveFolder?: boolean },
): Promise<{ removed: boolean; archivedTo: string | null }> {
  const archiveFolder = options?.archiveFolder ?? true;
  return withStoreWriteLock(async (map) => {
    const folder = map[sessionId];
    if (!folder) {
      return { removed: false, archivedTo: null };
    }
    delete map[sessionId];
    if (!archiveFolder) {
      return { removed: true, archivedTo: null };
    }
    try {
      await fs.mkdir(archiveRoot, { recursive: true });
      const destination = path.join(archiveRoot, `${sessionId}-${Date.now()}`);
      await fs.rename(folder, destination);
      return { removed: true, archivedTo: destination };
    } catch {
      return { removed: true, archivedTo: null };
    }
  });
}

export async function pruneSessionFolderMappings(activeSessionIds: string[]): Promise<{ removed: number }> {
  const active = new Set(activeSessionIds);
  return withStoreWriteLock(async (map) => {
    let removed = 0;
    for (const sessionId of Object.keys(map)) {
      if (!active.has(sessionId)) {
        delete map[sessionId];
        removed += 1;
      }
    }
    return { removed };
  });
}

function sessionContextPath(sessionId: string): string {
  return path.join(rovoSessionsRoot, sessionId, "session_context.json");
}

function ingestManifestPath(folder: string): string {
  return path.join(folder, ingestManifestName);
}

async function readIngestManifest(folder: string): Promise<IngestManifest> {
  try {
    const raw = await fs.readFile(ingestManifestPath(folder), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as IngestManifest) : {};
  } catch {
    return {};
  }
}

async function writeIngestManifest(folder: string, manifest: IngestManifest): Promise<void> {
  await fs.writeFile(ingestManifestPath(folder), JSON.stringify(manifest, null, 2), "utf8");
}

function extractArtifactPaths(raw: string): string[] {
  const matches = new Set<string>();
  const regex = /(?:^|[\s"'`])((?:\/Users\/|\/tmp\/|\/var\/)[^\s"'`]+?\.(?:md|pdf|docx|pptx|txt|csv|json|xlsx))(?:$|[\s"'`])/gi;
  for (const m of raw.matchAll(regex)) {
    const p = m[1];
    if (p) matches.add(p);
  }
  return Array.from(matches);
}

async function pickTargetPath(folder: string, sourcePath: string): Promise<string> {
  const ext = path.extname(sourcePath);
  const base = path.basename(sourcePath, ext);
  let candidate = path.join(folder, `${base}${ext}`);
  let idx = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(folder, `${base}-${idx}${ext}`);
      idx += 1;
    } catch {
      return candidate;
    }
  }
}

export async function ingestArtifactsFromSessionContext(sessionId: string): Promise<{ copied: number; skipped: number }> {
  const folder = await ensureSessionFolder(sessionId);
  const ctxPath = sessionContextPath(sessionId);
  let raw = "";
  try {
    raw = await fs.readFile(ctxPath, "utf8");
  } catch {
    return { copied: 0, skipped: 0 };
  }

  const manifest = await readIngestManifest(folder);
  const artifactPaths = extractArtifactPaths(raw);
  let copied = 0;
  let skipped = 0;

  for (const sourcePath of artifactPaths) {
    try {
      const ext = path.extname(sourcePath).toLowerCase();
      if (!artifactExtensions.has(ext)) {
        skipped += 1;
        continue;
      }
      if (sourcePath.startsWith(`${folder}${path.sep}`) || sourcePath === folder) {
        skipped += 1;
        continue;
      }
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        skipped += 1;
        continue;
      }
      const target = await pickTargetPath(folder, sourcePath);
      await fs.copyFile(sourcePath, target);
      manifest[path.basename(target)] = {
        sourcePath,
        ingestedAt: new Date().toISOString(),
      };
      copied += 1;
    } catch {
      skipped += 1;
    }
  }

  if (copied > 0) {
    await writeIngestManifest(folder, manifest);
  }
  return { copied, skipped };
}

export async function getIngestedArtifacts(folder: string): Promise<IngestManifest> {
  return readIngestManifest(folder);
}
