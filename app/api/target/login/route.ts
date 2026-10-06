import { NextResponse } from "next/server";
import { ManagementError, TOKEN_COOKIE, cookieOptions, isPlausibleToken, isSameOrigin, listProjects } from "@/lib/management";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "허용되지 않은 출처입니다." }, { status: 403 });
  let token: unknown;
  try {
    ({ token } = await req.json());
  } catch {
    return NextResponse.json({ error: "요청 본문(JSON)이 올바르지 않습니다." }, { status: 400 });
  }
  if (typeof token === "string") token = token.trim();
  if (!isPlausibleToken(token)) {
    return NextResponse.json({ error: "토큰 형식이 올바르지 않습니다. (sbp_로 시작하는 Personal Access Token)" }, { status: 400 });
  }
  try {
    const projects = await listProjects(token);
    const res = NextResponse.json({ ok: true, projectCount: projects.length });
    res.cookies.set(TOKEN_COOKIE, token, cookieOptions());
    return res;
  } catch (e) {
    const status = e instanceof ManagementError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status: status === 401 ? 401 : status });
  }
}
