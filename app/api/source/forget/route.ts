import { NextResponse } from "next/server";
import { SOURCE_KEY_COOKIE, guardRequest, sourceKeyCookieOptions } from "@/lib/source-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 저장된 service_role 키 쿠키 삭제 */
export async function POST(req: Request) {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SOURCE_KEY_COOKIE, "", { ...sourceKeyCookieOptions(), maxAge: 0 });
  return res;
}
