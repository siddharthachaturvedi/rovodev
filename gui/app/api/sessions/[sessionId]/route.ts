import { NextRequest, NextResponse } from "next/server";
import { deleteSession, restoreSession, toRouteError } from "@/lib/server/rovodev";
import { cleanupSessionFolderMapping, ensureSessionFolder, getSessionFolder } from "@/lib/server/sessionStore";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  const folderPath = await getSessionFolder(sessionId);
  return NextResponse.json({ sessionId, folderPath });
}

export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const folderPath = await ensureSessionFolder(sessionId);
    try {
      await restoreSession(sessionId);
    } catch (restoreErr) {
      const msg = (restoreErr as Error).message ?? "";
      if (msg.includes("409") || msg.toLowerCase().includes("chat in progress")) {
        return NextResponse.json({ ok: true, sessionId, folderPath, warning: "Chat in progress, session folder ready" });
      }
      throw restoreErr;
    }
    return NextResponse.json({ ok: true, sessionId, folderPath });
  } catch (error) {
    const mapped = toRouteError(error, "SESSION_RESTORE_FAILED");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    await deleteSession(sessionId);
    const cleanup = await cleanupSessionFolderMapping(sessionId, { archiveFolder: true });
    return NextResponse.json({ ok: true, cleanup });
  } catch (error) {
    const mapped = toRouteError(error, "SESSION_DELETE_FAILED");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
