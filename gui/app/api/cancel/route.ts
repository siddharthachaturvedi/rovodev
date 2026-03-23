import { NextResponse } from "next/server";

const DEFAULT_API_BASE = "http://127.0.0.1:8123";

function apiBase(): string {
  return process.env.ROVODEV_API_BASE ?? DEFAULT_API_BASE;
}

export async function POST() {
  try {
    const res = await fetch(`${apiBase()}/v3/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    const body = await res.text();
    return NextResponse.json({ ok: true, detail: body });
  } catch {
    return NextResponse.json({ ok: false, detail: "Cancel request timed out or failed" });
  }
}
