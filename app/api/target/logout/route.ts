import { NextResponse } from "next/server";
import { TOKEN_COOKIE, cookieOptions, isSameOrigin } from "@/lib/management";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "허용되지 않은 출처입니다." }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(TOKEN_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
  return res;
}
