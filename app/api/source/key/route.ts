import { NextResponse } from "next/server";
import { canonicalSourceUrl, describeKeyKind, encodeStoredKey, fetchOpenApi, isLowPrivilegeKey, isPlausibleApiKey } from "@/lib/source-core";
import { SOURCE_KEY_COOKIE, errorResponse, guardRequest, sourceKeyCookieOptions } from "@/lib/source-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 화면에서 입력한 service_role 키를 (URL과 묶어) httpOnly 쿠키에 저장합니다.
 * 저장 전에 그 URL의 OpenAPI 조회로 키가 동작하는지 확인합니다. 키는 응답/로그에 포함하지 않습니다.
 */
export async function POST(req: Request) {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  let body: { url?: unknown; key?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 본문(JSON)이 올바르지 않습니다." }, { status: 400 });
  }
  const url = canonicalSourceUrl(body.url);
  if (!url) return NextResponse.json({ error: "원본 URL이 올바르지 않습니다 (http(s)://..., 쿼리/해시 없이)." }, { status: 400 });
  const key = typeof body.key === "string" ? body.key.trim() : body.key;
  if (!isPlausibleApiKey(key)) return NextResponse.json({ error: "키 형식이 올바르지 않습니다." }, { status: 400 });
  const keyKind = describeKeyKind(key);
  if (isLowPrivilegeKey(keyKind)) {
    return NextResponse.json(
      { error: `입력한 키는 ${keyKind} 키입니다. RLS를 우회하려면 service_role(또는 sb_secret_) 키가 필요합니다. anon 키는 'anon key' 모드를 쓰세요.` },
      { status: 400 },
    );
  }
  try {
    const { tables } = await fetchOpenApi({ url, key });
    const res = NextResponse.json({ ok: true, url, keyKind, tableCount: tables.length });
    res.cookies.set(SOURCE_KEY_COOKIE, encodeStoredKey({ url, key }), sourceKeyCookieOptions());
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
