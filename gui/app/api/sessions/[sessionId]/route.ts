import { NextRequest, NextResponse } from "next/server";
import { deleteSession, restoreSession } from "@/lib/server/rovodev";
import { ensureSessionFolder, getSessionFolder } from "@/lib/server/sessionStore";

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
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    await deleteSession(sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
