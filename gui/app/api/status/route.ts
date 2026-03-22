import { NextResponse } from "next/server";
import { fetchRuntimeStatus } from "@/lib/server/rovodev";

export async function GET() {
  const runtime = await fetchRuntimeStatus();
  return NextResponse.json(runtime);
}
