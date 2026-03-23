import { NextResponse } from "next/server";
import { cancelChatStrict, toRouteError } from "@/lib/server/rovodev";

export async function POST() {
  try {
    await cancelChatStrict();
    return NextResponse.json({ ok: true });
  } catch (error) {
    const mapped = toRouteError(error, "CANCEL_FAILED");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
