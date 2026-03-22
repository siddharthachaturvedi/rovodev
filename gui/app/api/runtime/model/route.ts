import { NextRequest, NextResponse } from "next/server";
import { setAgentModel } from "@/lib/server/rovodev";

export async function PUT(request: NextRequest) {
  try {
    const payload = (await request.json()) as { modelId?: string };
    if (!payload.modelId) {
      return NextResponse.json({ error: "modelId is required" }, { status: 400 });
    }
    await setAgentModel(payload.modelId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
