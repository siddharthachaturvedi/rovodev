import { NextResponse } from "next/server";
import { cancelChat, createSession, listSessions } from "@/lib/server/rovodev";
import { ensureSessionFolder, getSessionFolder } from "@/lib/server/sessionStore";

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
    return NextResponse.json({ ok: true, sessions: enriched, warnings });
  } catch (error) {
    const message = (error as Error).message;
    return NextResponse.json({
      ok: false,
      sessions: [],
      warning: message,
      error: message,
    });
  }
}

export async function POST() {
  try {
    let session;
    try {
      session = await createSession();
    } catch (createErr) {
      const msg = (createErr as Error).message ?? "";
      if (msg.includes("409") || msg.toLowerCase().includes("chat in progress")) {
        await cancelChat();
        session = await createSession();
      } else {
        throw createErr;
      }
    }
    const folderPath = await ensureSessionFolder(session.id);
    return NextResponse.json({ ok: true, session: { ...session, folderPath } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
