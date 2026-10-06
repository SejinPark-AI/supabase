import { NextResponse } from "next/server";
import { errorResponse, getSchema, guardRequest, parseMode, resolveServiceConn } from "@/lib/source-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** service_role 키로 원본 OpenAPI 스키마를 조회해 파싱 결과를 돌려줍니다. */
export async function GET(req: Request) {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  try {
    const q = new URL(req.url).searchParams;
    const conn = await resolveServiceConn(parseMode(q.get("mode")), q.get("url"));
    const result = await getSchema(conn, true);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
