import { NextResponse } from "next/server";
import { fetchRuntimeStatus, toRouteError } from "@/lib/server/rovodev";

export async function GET() {
  try {
    const runtime = await fetchRuntimeStatus();
    return NextResponse.json(runtime);
  } catch (error) {
    const mapped = toRouteError(error, "STATUS_FETCH_FAILED");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
