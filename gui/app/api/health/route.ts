import { NextResponse } from "next/server";
import { fetchHealth } from "@/lib/server/rovodev";

export async function GET() {
  const health = await fetchHealth();
  if (!health) {
    return NextResponse.json(
      { ok: false, message: "Rovo Dev server unavailable. Start with: acli rovodev serve 8123" },
      { status: 503 }
    );
  }
  return NextResponse.json({ ok: true, health });
}
