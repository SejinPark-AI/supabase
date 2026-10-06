import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ManagementError, TOKEN_COOKIE, isSameOrigin, isValidRef, runQuery } from "@/lib/management";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "허용되지 않은 출처입니다." }, { status: 403 });
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  let body: { ref?: unknown; query?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 본문(JSON)이 올바르지 않습니다." }, { status: 400 });
  }
  if (!isValidRef(body.ref)) return NextResponse.json({ error: "프로젝트 ref 형식이 올바르지 않습니다." }, { status: 400 });
  if (typeof body.query !== "string" || !body.query.trim()) {
    return NextResponse.json({ error: "query가 비어 있습니다." }, { status: 400 });
  }
  try {
    const result = await runQuery(token, body.ref, body.query);
    return NextResponse.json({ result });
  } catch (e) {
    const status = e instanceof ManagementError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
