/**
 * service_role 키로 원본을 읽는 서버 전용 로직.
 *
 * 보안 원칙
 * - 키는 브라우저로 보내지 않습니다 (응답 본문/로그에 포함 금지).
 * - env 키(SUPABASE_SERVICE_ROLE_KEY)는 NEXT_PUBLIC_SUPABASE_URL로만, 쿠키 키는 저장 시 묶인 URL로만 보냅니다.
 *   요청 대상 URL은 항상 서버가 env/쿠키에서 결정하며, 요청에서 받은 URL은 일치 확인에만 씁니다.
 * - env 키는 PAT로 로그인한 계정이 원본 프로젝트에 접근할 수 있을 때만 사용합니다
 *   (*.supabase.co가 아니면 ALLOW_UNVERIFIED_SERVICE_ROLE=true 필요).
 * - 테이블 이름은 원본 OpenAPI 테이블 목록에 있는 것만 허용합니다.
 */
import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { ParseResult, TableDef } from "./ddl";
import { ManagementError, TOKEN_COOKIE, TOKEN_MAX_AGE, cookieOptions, isSameOrigin, listProjects } from "./management";
import {
  SourceError,
  checkCookieAccess,
  checkEnvAccess,
  decideEnvMode,
  decodeStoredKey,
  describeKeyKind,
  fetchOpenApi,
  isKnownTable,
  type AccessResult,
  type EnvModeDecision,
  type RestConn,
  type StoredSourceKey,
} from "./source-core";

export const SOURCE_KEY_COOKIE = "sb_src_service_key";
export const SOURCE_KEY_MAX_AGE = TOKEN_MAX_AGE;

export type ServerMode = "env" | "cookie";

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function sourceKeyCookieOptions() {
  return { ...cookieOptions(), maxAge: SOURCE_KEY_MAX_AGE };
}

// ---------------------------------------------------------------------------
// 요청 가드 / 응답 헬퍼
// ---------------------------------------------------------------------------

/** Origin 검사(기존 헬퍼) + 브라우저가 알려주는 교차 사이트 요청 거부. 통과하면 null. */
export function guardRequest(req: Request): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  if (!isSameOrigin(req) || site === "cross-site") {
    return NextResponse.json({ error: "허용되지 않은 출처입니다." }, { status: 403 });
  }
  return null;
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError || e instanceof SourceError || e instanceof ManagementError) {
    // ManagementError 401은 "PAT가 만료됨"이므로 그대로 401
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
}

export function parseMode(v: unknown): ServerMode {
  if (v === "env" || v === "cookie") return v;
  throw new HttpError("mode는 env 또는 cookie 여야 합니다.", 400);
}

// ---------------------------------------------------------------------------
// env 설정
// ---------------------------------------------------------------------------

function envKey(): string {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
}

export function envDecision(): EnvModeDecision {
  return decideEnvMode({
    envUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    hasKey: envKey().length > 0,
    allowUnverified: process.env.ALLOW_UNVERIFIED_SERVICE_ROLE === "true",
  });
}

export function envKeyKind(): string | undefined {
  const k = envKey();
  return k ? describeKeyKind(k) : undefined;
}

// ---------------------------------------------------------------------------
// PAT 계정의 프로젝트 접근 확인 (토큰별 60초 캐시)
// ---------------------------------------------------------------------------

const ACCESS_TTL_MS = 60_000;
const accessCache = new Map<string, { expires: number; refs: Promise<string[]> }>();

function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function accessibleProjectRefs(token: string): Promise<string[]> {
  const now = Date.now();
  for (const [k, v] of accessCache) if (v.expires <= now) accessCache.delete(k);
  const id = tokenId(token);
  const hit = accessCache.get(id);
  if (hit) return hit.refs;
  const refs = listProjects(token).then((ps) => ps.map((p) => p.ref));
  accessCache.set(id, { expires: now + ACCESS_TTL_MS, refs });
  // 실패한 결과는 캐시하지 않음
  refs.catch(() => accessCache.delete(id));
  return refs;
}

// ---------------------------------------------------------------------------
// 키/URL 결정
// ---------------------------------------------------------------------------

export async function readStoredKey(): Promise<StoredSourceKey | null> {
  return decodeStoredKey((await cookies()).get(SOURCE_KEY_COOKIE)?.value);
}

/** env 모드 접근 확인 (상태 표시용으로도 사용) */
export async function evaluateEnvAccess(expectUrl: unknown): Promise<AccessResult> {
  const decision = envDecision();
  let accessibleRefs: string[] | null = null;
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  // 접근 확인이 필요한 경우에만 Management API 호출 (URL 불일치 등은 먼저 거부)
  const pre = checkEnvAccess({ decision, expectUrl, hasToken: !!token, accessibleRefs: [] });
  const needsRefs = decision.available && decision.gate === "project-access" && !!token && (pre.ok || pre.status === 403);
  if (needsRefs) {
    try {
      accessibleRefs = await accessibleProjectRefs(token!);
    } catch (e) {
      if (e instanceof ManagementError) {
        const status = e.status === 401 ? 401 : 502;
        return { ok: false, status, error: `원본 프로젝트 접근 권한 확인 실패: ${e.message}` };
      }
      throw e;
    }
    return checkEnvAccess({ decision, expectUrl, hasToken: true, accessibleRefs });
  }
  return pre;
}

/**
 * service_role 연결 정보를 결정합니다. 대상 URL은 env/쿠키에서만 가져옵니다.
 * expectUrl(요청 값)은 일치 확인용이며 요청 대상이 되지 않습니다.
 */
export async function resolveServiceConn(mode: ServerMode, expectUrl: unknown): Promise<RestConn> {
  if (mode === "env") {
    const r = await evaluateEnvAccess(expectUrl);
    if (!r.ok) throw new HttpError(r.error, r.status);
    return { url: r.url, key: envKey() };
  }
  const stored = await readStoredKey();
  const r = checkCookieAccess({ stored, expectUrl });
  if (!r.ok) throw new HttpError(r.error, r.status);
  return { url: r.url, key: stored!.key };
}

// ---------------------------------------------------------------------------
// OpenAPI (테이블 목록) 캐시 — 테이블 이름 검증에 사용
// ---------------------------------------------------------------------------

const SPEC_TTL_MS = 60_000;
const specCache = new Map<string, { expires: number; result: Promise<ParseResult> }>();

function connId(conn: RestConn): string {
  return createHash("sha256").update(`${conn.url}\n${conn.key}`).digest("hex");
}

export async function getSchema(conn: RestConn, fresh = false): Promise<ParseResult> {
  const now = Date.now();
  for (const [k, v] of specCache) if (v.expires <= now) specCache.delete(k);
  const id = connId(conn);
  const hit = specCache.get(id);
  if (hit && !fresh) return hit.result;
  const result = fetchOpenApi(conn);
  specCache.set(id, { expires: now + SPEC_TTL_MS, result });
  result.catch(() => specCache.delete(id));
  return result;
}

/** 요청의 테이블 이름을 원본 OpenAPI 테이블 목록과 대조해 TableDef를 돌려줍니다. */
export async function getKnownTable(conn: RestConn, name: unknown): Promise<TableDef> {
  const { tables } = await getSchema(conn);
  if (!isKnownTable(name, tables.map((t) => t.name))) {
    throw new HttpError("원본 스키마에 없는 테이블입니다.", 400);
  }
  return tables.find((t) => t.name === name)!;
}

/** 0 이상의 정수 파라미터 */
export function intParam(v: string | null, name: string, max: number, fallback?: number): number {
  if (v == null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new HttpError(`${name} 값이 필요합니다.`, 400);
  }
  if (!/^\d{1,12}$/.test(v)) throw new HttpError(`${name} 값이 올바르지 않습니다.`, 400);
  const n = Number(v);
  if (n > max) throw new HttpError(`${name} 값이 너무 큽니다 (최대 ${max}).`, 400);
  return n;
}
