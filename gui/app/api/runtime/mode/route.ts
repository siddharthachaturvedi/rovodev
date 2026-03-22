import { NextRequest, NextResponse } from "next/server";
import { setAgentMode } from "@/lib/server/rovodev";

export async function PUT(request: NextRequest) {
  try {
    const payload = (await request.json()) as { mode?: string };
    if (!payload.mode) {
      return NextResponse.json({ error: "mode is required" }, { status: 400 });
    }
    await setAgentMode(payload.mode);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
