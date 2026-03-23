import { NextRequest, NextResponse } from "next/server";
import { getIngestedArtifacts, getSessionFolder, ingestArtifactsFromSessionContext } from "@/lib/server/sessionStore";
import fs from "node:fs/promises";
import path from "node:path";

type FileEntry = {
  name: string;
  size: number;
  mtime: string;
  isDirectory: boolean;
  fullPath?: string;
  source?: "session" | "ingested";
};

async function listDirFiles(baseDir: string): Promise<FileEntry[]> {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const files: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(baseDir, entry.name);
      try {
        const stat = await fs.stat(full);
        files.push({
          name: entry.name,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          isDirectory: entry.isDirectory(),
          fullPath: full,
          source: "session",
        });
      } catch {
        files.push({
          name: entry.name,
          size: 0,
          mtime: new Date().toISOString(),
          isDirectory: entry.isDirectory(),
          fullPath: full,
          source: "session",
        });
      }
    }
    return files;
  } catch {
    return [];
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const folder = await getSessionFolder(sessionId);
  if (!folder) {
    return NextResponse.json({ files: [], folderPath: null });
  }

  try {
    await ingestArtifactsFromSessionContext(sessionId);
    const ingested = await getIngestedArtifacts(folder);
    const files = await listDirFiles(folder);
    for (const file of files) {
      if (!file.isDirectory && ingested[file.name]) {
        file.source = "ingested";
      }
    }
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return b.mtime.localeCompare(a.mtime);
    });
    return NextResponse.json({ files, folderPath: folder });
  } catch {
    return NextResponse.json({ files: [], folderPath: folder });
  }
}
