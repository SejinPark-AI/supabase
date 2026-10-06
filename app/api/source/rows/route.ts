import { PAGE_SIZE, fetchPageText } from "@/lib/source-core";
import { errorResponse, getKnownTable, guardRequest, intParam, parseMode, resolveServiceConn } from "@/lib/source-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 한 페이지(최대 PAGE_SIZE행). select/정렬은 서버가 원본 스키마로 직접 만듭니다 (클라이언트 anon 모드와 같은 빌더). */
export async function GET(req: Request) {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  try {
    const q = new URL(req.url).searchParams;
    const conn = await resolveServiceConn(parseMode(q.get("mode")), q.get("url"));
    const table = await getKnownTable(conn, q.get("table"));
    const from = intParam(q.get("from"), "from", Number.MAX_SAFE_INTEGER);
    const size = intParam(q.get("size"), "size", PAGE_SIZE, PAGE_SIZE);
    if (size < 1) return Response.json({ error: "size 값이 올바르지 않습니다." }, { status: 400 });
    // PostgREST 응답(JSON 배열)을 그대로 전달 — 숫자 정밀도 유지
    const text = await fetchPageText(conn, table, from, size);
    return new Response(text, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
