import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", runtime: "nextjs", data: "synthetic-only" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
