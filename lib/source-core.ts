/**
 * 원본(source) PostgREST 접근의 공통 로직 — 브라우저(anon 모드)와 서버(service_role 모드)가 함께 씁니다.
 *
 * 이 파일에는 비밀 값이 없습니다. 키는 호출하는 쪽이 RestConn으로 넘깁니다.
 * (서버 전용 로직과 키 보관은 lib/source-server.ts)
 */
import { buildSelectList, parseOpenApi, pgrstColumnRef, type ParseResult, type TableDef } from "./ddl";

export const PAGE_SIZE = 1000;

/** 원본 읽기 방식 */
export type SourceMode = "anon" | "service-env" | "service-cookie";

export const SOURCE_MODE_LABEL: Record<SourceMode, string> = {
  anon: "anon 키 (RLS 적용)",
  "service-env": "service_role (env)",
  "service-cookie": "service_role (직접 입력)",
};

export class SourceError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "SourceError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// URL 정규화 / 비교 / ref 추출
// ---------------------------------------------------------------------------

/** 입력값 다듬기 (공백, 끝 슬래시 제거) — 화면 표시용 */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * 비교·요청용 정규 URL. http(s)만 허용하고, 사용자 정보/쿼리/해시가 있으면 null.
 * 호스트는 소문자, 기본 포트 제거, 끝 슬래시 제거. 예: "HTTPS://Abc.Supabase.co:443/" → "https://abc.supabase.co"
 */
export function canonicalSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.search || u.hash || s.includes("?") || s.includes("#")) return null;
  if (!u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** 두 URL이 같은 원본을 가리키는지 (정규화 후 완전 일치). 어느 한쪽이라도 잘못된 URL이면 false. */
export function sameSourceUrl(a: unknown, b: unknown): boolean {
  const ca = canonicalSourceUrl(a);
  return ca !== null && ca === canonicalSourceUrl(b);
}

/** `https://<ref>.supabase.co` 형태면 ref, 아니면 null (자체 호스팅/로컬 등) */
export function projectRefFromUrl(raw: unknown): string | null {
  const c = canonicalSourceUrl(raw);
  if (!c) return null;
  const u = new URL(c);
  if (u.protocol !== "https:" || u.port || u.pathname !== "/") return null;
  const m = u.hostname.match(/^([a-z0-9]{1,64})\.supabase\.co$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 테이블 이름 / 키 형식
// ---------------------------------------------------------------------------

/**
 * 요청 경로에 넣을 테이블 이름의 기본 검증 (서버는 추가로 OpenAPI 테이블 목록과 대조).
 * Postgres 식별자 한도(63바이트), 제어문자 금지, "."/".." 같은 경로 조각 금지.
 */
export function isSafeTableName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  if (new TextEncoder().encode(name).length > 63) return false;
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  if (/^\.+$/.test(name)) return false;
  return true;
}

/** 테이블 이름이 형식상 안전하고, 알려진 목록에 있는지 */
export function isKnownTable(name: unknown, known: Iterable<string>): name is string {
  if (!isSafeTableName(name)) return false;
  for (const k of known) if (k === name) return true;
  return false;
}

/** API 키 형식 기본 검증 (JWT 또는 sb_secret_/sb_publishable_ 키) */
export function isPlausibleApiKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 20 && key.length <= 4096 && /^[A-Za-z0-9_\-.]+$/.test(key);
}

export type KeyKind = "service_role" | "anon" | "secret" | "publishable" | "jwt-other" | "unknown";

/** 키 종류 추정 (서명 검증 없음 — 안내용). JWT면 payload.role, 새 형식이면 접두사로 판단. */
export function describeKeyKind(key: string): KeyKind {
  if (key.startsWith("sb_secret_")) return "secret";
  if (key.startsWith("sb_publishable_")) return "publishable";
  const parts = key.split(".");
  if (parts.length === 3 && key.startsWith("eyJ")) {
    try {
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
      if (json?.role === "service_role") return "service_role";
      if (json?.role === "anon") return "anon";
      return "jwt-other";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/** service_role 모드에 쓰기에 부적절한(RLS를 우회하지 못하는) 키인지 */
export function isLowPrivilegeKey(kind: KeyKind): boolean {
  return kind === "anon" || kind === "publishable";
}

// ---------------------------------------------------------------------------
// env service_role 모드 사용 가능 여부 / 접근 결정 (순수 함수)
// ---------------------------------------------------------------------------

export type EnvModeDecision =
  | { available: false; reason: string }
  | { available: true; url: string; ref: string | null; gate: "project-access" | "unverified" };

export function decideEnvMode(input: { envUrl: string | undefined; hasKey: boolean; allowUnverified: boolean }): EnvModeDecision {
  if (!input.hasKey) return { available: false, reason: "서버에 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다." };
  const url = canonicalSourceUrl(input.envUrl ?? "");
  if (!url) return { available: false, reason: "NEXT_PUBLIC_SUPABASE_URL이 없거나 올바른 http(s) URL이 아닙니다." };
  const ref = projectRefFromUrl(url);
  if (ref) return { available: true, url, ref, gate: "project-access" };
  if (input.allowUnverified) return { available: true, url, ref: null, gate: "unverified" };
  return {
    available: false,
    reason:
      "원본 URL이 *.supabase.co 프로젝트가 아니어서(자체 호스팅/로컬) Supabase 계정으로 접근 권한을 확인할 수 없습니다. " +
      "env service_role 모드를 쓰려면 서버 환경 변수 ALLOW_UNVERIFIED_SERVICE_ROLE=true 를 설정하세요 (이 경우 앱에 접근 가능한 누구나 DB 전체를 읽을 수 있습니다).",
  };
}

export type AccessResult = { ok: true; url: string } | { ok: false; status: number; error: string };

/**
 * env 키 사용 허가 판단.
 * - expectUrl: 화면에서 사용자가 보고 있는 원본 URL (요청 대상 결정에는 쓰지 않고, 일치 확인에만 사용)
 * - accessibleRefs: PAT 계정으로 볼 수 있는 프로젝트 ref 목록 (gate가 project-access일 때만 필요)
 */
export function checkEnvAccess(input: {
  decision: EnvModeDecision;
  expectUrl: unknown;
  hasToken: boolean;
  accessibleRefs: readonly string[] | null;
}): AccessResult {
  const d = input.decision;
  if (!d.available) return { ok: false, status: 409, error: d.reason };
  if (!sameSourceUrl(input.expectUrl, d.url)) {
    return {
      ok: false,
      status: 409,
      error: `화면의 원본 URL이 환경 변수 NEXT_PUBLIC_SUPABASE_URL(${d.url})과 다릅니다. env service_role 키는 환경 변수 URL에만 사용할 수 있습니다.`,
    };
  }
  if (d.gate === "unverified") return { ok: true, url: d.url };
  if (!input.hasToken) {
    return { ok: false, status: 401, error: "env service_role 모드는 Supabase 계정 로그인(Personal Access Token)이 필요합니다." };
  }
  if (!input.accessibleRefs) return { ok: false, status: 502, error: "프로젝트 접근 권한을 확인하지 못했습니다." };
  if (!input.accessibleRefs.includes(d.ref!)) {
    return { ok: false, status: 403, error: `로그인한 Supabase 계정에서 원본 프로젝트(${d.ref})에 접근할 수 없습니다.` };
  }
  return { ok: true, url: d.url };
}

/** 쿠키에 저장된 (URL, 키) 사용 허가 판단: 키는 저장할 때의 URL에만 보냅니다. */
export function checkCookieAccess(input: { stored: { url: string } | null; expectUrl: unknown }): AccessResult {
  if (!input.stored) return { ok: false, status: 409, error: "저장된 service_role 키가 없습니다. 원본 단계에서 키를 다시 입력하세요." };
  const url = canonicalSourceUrl(input.stored.url);
  if (!url) return { ok: false, status: 409, error: "저장된 키의 URL이 올바르지 않습니다. 키를 다시 입력하세요." };
  if (!sameSourceUrl(input.expectUrl, url)) {
    return {
      ok: false,
      status: 409,
      error: `저장된 service_role 키는 ${url} 에 묶여 있습니다. 다른 URL에는 사용할 수 없으니 키를 다시 입력하세요.`,
    };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// 키 쿠키 직렬화 (URL + 키를 함께 저장)
// ---------------------------------------------------------------------------

export interface StoredSourceKey {
  url: string;
  key: string;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeStoredKey(v: StoredSourceKey): string {
  return toBase64Url(JSON.stringify({ u: v.url, k: v.key }));
}

export function decodeStoredKey(raw: string | undefined | null): StoredSourceKey | null {
  if (!raw || raw.length > 8192) return null;
  try {
    const j = JSON.parse(fromBase64Url(raw));
    const url = canonicalSourceUrl(j?.u);
    if (!url || !isPlausibleApiKey(j?.k)) return null;
    return { url, key: j.k };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PostgREST 요청 (브라우저/서버 공통)
// ---------------------------------------------------------------------------

export interface RestConn {
  /** canonicalSourceUrl 결과 */
  url: string;
  key: string;
}

export function authHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key };
  // 새로운 sb_publishable_/sb_secret_ 키는 JWT가 아니므로 apikey 헤더만 보냅니다.
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

/** 테이블 경로 (`/rest/v1/<encoded>`). 형식 검증에 실패하면 예외. */
export function tablePath(name: string): string {
  if (!isSafeTableName(name)) throw new SourceError(`테이블 이름이 올바르지 않습니다: ${JSON.stringify(String(name)).slice(0, 80)}`, 400);
  return `/rest/v1/${encodeURIComponent(name)}`;
}

/** 페이지 정렬: PK가 있으면 PK 오름차순 */
export function buildOrderParam(table: TableDef): string | null {
  if (table.primaryKey.length === 0) return null;
  return table.primaryKey.map((c) => `${pgrstColumnRef(c)}.asc`).join(",");
}

/** 한 페이지를 읽는 쿼리 문자열 (select / order / offset / limit) — anon/service 모드가 동일하게 사용 */
export function buildPageQuery(table: TableDef, from: number, size: number = PAGE_SIZE): string {
  const p = new URLSearchParams();
  p.set("select", buildSelectList(table));
  const order = buildOrderParam(table);
  if (order) p.set("order", order);
  p.set("offset", String(from));
  p.set("limit", String(size));
  return p.toString();
}

/** Content-Range 헤더("0-9/123", "* /0")에서 전체 행 수 */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const m = header.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function errorDetail(text: string): string {
  let detail = text.slice(0, 500);
  try {
    const j = JSON.parse(text);
    detail = j.message ?? j.msg ?? j.hint ?? detail;
  } catch {
    /* ignore */
  }
  return String(detail);
}

async function restFetch(conn: RestConn, pathAndQuery: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  try {
    return await fetch(`${conn.url}${pathAndQuery}`, {
      method: init.method ?? "GET",
      headers: { ...authHeaders(conn.key), ...(init.headers ?? {}) },
      cache: "no-store",
      // 리다이렉트를 따라가면 apikey 헤더가 다른 호스트로 전달될 수 있으므로 거부합니다.
      redirect: "error",
    });
  } catch (e) {
    throw new SourceError(`원본 프로젝트에 연결할 수 없습니다 (URL/네트워크/CORS/리다이렉트 확인): ${(e as Error).message}`, 502);
  }
}

/** PostgREST OpenAPI 문서를 받아 파싱합니다. */
export async function fetchOpenApi(conn: RestConn): Promise<ParseResult> {
  const res = await restFetch(conn, "/rest/v1/", { headers: { Accept: "application/openapi+json, application/json" } });
  const text = await res.text();
  if (!res.ok) {
    const detail = errorDetail(text);
    if (res.status === 401 || res.status === 403) {
      throw new SourceError(
        `OpenAPI 스키마 조회가 거부되었습니다 (HTTP ${res.status}: ${detail}). ` +
          "프로젝트 설정에서 이 키로 스키마 조회가 차단되어 있을 수 있습니다. " +
          "API 키가 올바른지 확인하거나, 스키마 조회가 허용된 키를 입력하세요.",
        502,
      );
    }
    throw new SourceError(`OpenAPI 스키마 조회 실패 (HTTP ${res.status}): ${detail}`, 502);
  }
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch {
    throw new SourceError("OpenAPI 응답을 JSON으로 해석할 수 없습니다.", 502);
  }
  return parseOpenApi(spec);
}

/** 정확한 행 수 (Prefer: count=exact, HEAD) */
export async function fetchCount(conn: RestConn, table: string): Promise<number | null> {
  const path = `${tablePath(table)}?select=*`;
  const res = await restFetch(conn, path, { method: "HEAD", headers: { Prefer: "count=exact" } });
  if (!res.ok) {
    // HEAD 응답에는 본문이 없으므로 오류 메시지를 얻기 위해 GET으로 한 번 더 요청
    const again = await restFetch(conn, `${path}&limit=1`);
    const text = await again.text().catch(() => "");
    throw new SourceError(`${table} 행 수 조회 실패 (HTTP ${res.status}): ${errorDetail(text) || res.statusText}`, 502);
  }
  return parseContentRangeTotal(res.headers.get("content-range"));
}

/** 한 페이지의 원문 JSON(배열 텍스트)을 받습니다. */
export async function fetchPageText(conn: RestConn, table: TableDef, from: number, size: number = PAGE_SIZE): Promise<string> {
  const res = await restFetch(conn, `${tablePath(table.name)}?${buildPageQuery(table, from, size)}`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new SourceError(`${table.name} 읽기 실패 (offset ${from}, HTTP ${res.status}): ${errorDetail(text)}`, 502);
  if (!text.trimStart().startsWith("[")) throw new SourceError(`${table.name} 읽기 실패 (offset ${from}): 배열 응답이 아닙니다.`, 502);
  return text;
}

export async function fetchPage(conn: RestConn, table: TableDef, from: number, size: number = PAGE_SIZE): Promise<Record<string, unknown>[]> {
  return JSON.parse(await fetchPageText(conn, table, from, size)) as Record<string, unknown>[];
}
