import { NextResponse } from "next/server";
import { fetchCount } from "@/lib/source-core";
import { errorResponse, getKnownTable, guardRequest, parseMode, resolveServiceConn } from "@/lib/source-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  try {
    const q = new URL(req.url).searchParams;
    const conn = await resolveServiceConn(parseMode(q.get("mode")), q.get("url"));
    const table = await getKnownTable(conn, q.get("table"));
    const count = await fetchCount(conn, table.name);
    return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
