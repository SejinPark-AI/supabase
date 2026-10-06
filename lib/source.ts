/**
 * 원본(source) 읽기 — 브라우저용 SourceReader.
 *
 * - anon 모드: 브라우저가 anon 키로 PostgREST를 직접 호출 (RLS 적용)
 * - service_role 모드: /api/source/* 서버 라우트를 호출. 키는 서버(env 또는 httpOnly 쿠키)에만 있고,
 *   브라우저는 키를 보거나 보내지 않습니다.
 *
 * 두 경로 모두 lib/source-core.ts의 같은 select/order/페이지 쿼리 빌더를 씁니다.
 */
import type { ParseResult, TableDef } from "./ddl";
import {
  PAGE_SIZE,
  SOURCE_MODE_LABEL,
  SourceError,
  canonicalSourceUrl,
  fetchCount,
  fetchOpenApi,
  fetchPage,
  normalizeUrl,
  type RestConn,
  type SourceMode,
} from "./source-core";

export { PAGE_SIZE, SOURCE_MODE_LABEL, SourceError, normalizeUrl };
export type { SourceMode };

export interface SourceReader {
  readonly mode: SourceMode;
  /** 정규화된 원본 URL (표시용) */
  readonly url: string;
  introspect(): Promise<ParseResult>;
  count(table: string): Promise<number | null>;
  fetchPage(table: TableDef, from: number, size?: number): Promise<Record<string, unknown>[]>;
}

export function createAnonReader(url: string, anonKey: string): SourceReader {
  const canonical = canonicalSourceUrl(url);
  if (!canonical) throw new SourceError("원본 URL이 올바르지 않습니다 (http(s)://... 형식, 쿼리/해시 없이).", 400);
  const conn: RestConn = { url: canonical, key: anonKey.trim() };
  return {
    mode: "anon",
    url: canonical,
    introspect: () => fetchOpenApi(conn),
    count: (table) => fetchCount(conn, table),
    fetchPage: (table, from, size = PAGE_SIZE) => fetchPage(conn, table, from, size),
  };
}

async function apiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${path}?${new URLSearchParams(params)}`, { cache: "no-store", credentials: "same-origin" });
  } catch (e) {
    throw new SourceError(`서버에 연결할 수 없습니다: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new SourceError(msg, res.status);
  }
  return body as T;
}

/**
 * 서버 프록시 리더. `url`은 화면에 표시된 원본 URL로, 서버가 저장된(env/쿠키) URL과 일치하는지
 * 확인하는 데만 쓰입니다. 서버는 이 값을 요청 대상 결정에 쓰지 않습니다.
 */
export function createServerReader(mode: "service-env" | "service-cookie", url: string): SourceReader {
  const canonical = canonicalSourceUrl(url);
  if (!canonical) throw new SourceError("원본 URL이 올바르지 않습니다.", 400);
  const m = mode === "service-env" ? "env" : "cookie";
  return {
    mode,
    url: canonical,
    introspect: () => apiGet<ParseResult>("/api/source/openapi", { mode: m, url: canonical }),
    count: async (table) => (await apiGet<{ count: number | null }>("/api/source/count", { mode: m, url: canonical, table })).count,
    fetchPage: (table, from, size = PAGE_SIZE) =>
      apiGet<Record<string, unknown>[]>("/api/source/rows", { mode: m, url: canonical, table: table.name, from: String(from), size: String(size) }),
  };
}

export function describeReader(r: SourceReader): string {
  return `${SOURCE_MODE_LABEL[r.mode]} · ${r.url}`;
}

// ---------------------------------------------------------------------------
// 서버 상태 / 키 저장
// ---------------------------------------------------------------------------

export interface SourceStatus {
  env: { available: boolean; reason?: string; url: string | null; ref: string | null; gate?: "project-access" | "unverified"; keyKind?: string };
  /** env 모드 접근 권한 (gate가 project-access일 때) */
  envAccess: { state: "ok" | "login-required" | "denied" | "error" | "not-applicable"; message?: string };
  cookie: { present: boolean; url: string | null; keyKind?: string };
  loggedIn: boolean;
}

export async function fetchSourceStatus(): Promise<SourceStatus> {
  return apiGet<SourceStatus>("/api/source/status", {});
}

export async function saveServiceKey(url: string, key: string): Promise<{ url: string; keyKind: string; warning?: string }> {
  const res = await fetch("/api/source/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, key }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new SourceError(body.error ?? `HTTP ${res.status}`, res.status);
  return body;
}

export async function forgetServiceKey(): Promise<void> {
  await fetch("/api/source/forget", { method: "POST" });
}
