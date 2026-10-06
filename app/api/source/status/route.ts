import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { TOKEN_COOKIE } from "@/lib/management";
import { describeKeyKind } from "@/lib/source-core";
import { envDecision, envKeyKind, errorResponse, evaluateEnvAccess, guardRequest, readStoredKey } from "@/lib/source-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 사용 가능한 원본 읽기 모드. 키 값은 절대 포함하지 않습니다. */
export async function GET(req: Request) {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  try {
    const decision = envDecision();
    const loggedIn = !!(await cookies()).get(TOKEN_COOKIE)?.value;
    let envAccess: { state: "ok" | "login-required" | "denied" | "error" | "not-applicable"; message?: string } = { state: "not-applicable" };
    if (decision.available) {
      const r = await evaluateEnvAccess(decision.url);
      if (r.ok) envAccess = { state: "ok" };
      else if (r.status === 401) envAccess = { state: "login-required", message: r.error };
      else if (r.status === 403) envAccess = { state: "denied", message: r.error };
      else envAccess = { state: "error", message: r.error };
    }
    const stored = await readStoredKey();
    return NextResponse.json({
      env: decision.available
        ? { available: true, url: decision.url, ref: decision.ref, gate: decision.gate, keyKind: envKeyKind() }
        : { available: false, reason: decision.reason, url: null, ref: null },
      envAccess,
      cookie: stored ? { present: true, url: stored.url, keyKind: describeKeyKind(stored.key) } : { present: false, url: null },
      loggedIn,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
