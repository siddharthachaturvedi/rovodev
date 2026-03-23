import { NextRequest, NextResponse } from "next/server";
import {
  cancelChat,
  createSession,
  deleteAllSessions,
  isRovoDevApiError,
  listSessions,
  resetAgent,
  toRouteError,
} from "@/lib/server/rovodev";
import { ensureSessionFolder, getSessionFolder, pruneSessionFolderMappings } from "@/lib/server/sessionStore";

function isChatInProgressError(error: unknown): boolean {
  if (isRovoDevApiError(error)) {
    return error.status === 409;
  }
  const msg = (error as Error)?.message ?? "";
  return msg.includes("409") || msg.toLowerCase().includes("chat in progress");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET() {
  try {
    const sessions = await listSessions();
    const warnings: string[] = [];
    const enriched = await Promise.all(
      sessions.map(async (session) => {
        try {
          return {
            ...session,
            folderPath: (await getSessionFolder(session.id)) ?? (await ensureSessionFolder(session.id))
          };
        } catch (error) {
          warnings.push(`Could not map folder for ${session.id}: ${(error as Error).message}`);
          return session;
        }
      })
    );
    await pruneSessionFolderMappings(sessions.map((s) => s.id));
    return NextResponse.json({ ok: true, sessions: enriched, warnings });
  } catch (error) {
    const mapped = toRouteError(error, "SESSIONS_LIST_FAILED");
    return NextResponse.json({ ...mapped.body, sessions: [] }, { status: mapped.status });
  }
}

export async function POST(_request: NextRequest) {
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const session = await createSession();
        const folderPath = await ensureSessionFolder(session.id);
        return NextResponse.json({ ok: true, session: { ...session, folderPath } });
      } catch (createErr) {
        lastError = createErr;
        if (!isChatInProgressError(createErr)) {
          throw createErr;
        }
        await cancelChat();
        await sleep(250 + attempt * 250);
      }
    }
    // Last-resort recovery path for stale backend chat locks.
    await resetAgent();
    await sleep(300);
    const recovered = await createSession();
    const folderPath = await ensureSessionFolder(recovered.id);
    return NextResponse.json({ ok: true, session: { ...recovered, folderPath }, recoveredFromStuckChat: true });
  } catch (error) {
    const mapped = toRouteError(error, "SESSION_CREATE_FAILED");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}

export async function DELETE() {
  try {
    const result = await deleteAllSessions();
    await pruneSessionFolderMappings([]);
    return NextResponse.json({ ok: true, deleted: result.deletedIds.length, attempted: result.attempted });
  } catch (error) {
    const mapped = toRouteError(error, "SESSIONS_DELETE_FAILED");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
