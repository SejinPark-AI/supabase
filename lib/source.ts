/**
 * 원본(source) Supabase 접근 — 브라우저에서 anon 키로 실행됩니다.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildSelectList, parseOpenApi, type ParseResult, type TableDef } from "./ddl";

export const PAGE_SIZE = 1000;

export interface SourceConfig {
  url: string;
  anonKey: string;
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function authHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key };
  // 새로운 sb_publishable_/sb_secret_ 키는 JWT가 아니므로 apikey 헤더만 보냅니다.
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

export class SourceError extends Error {}

/** PostgREST OpenAPI로 스키마를 조회합니다. */
export async function introspect(cfg: SourceConfig): Promise<ParseResult> {
  const url = normalizeUrl(cfg.url);
  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1/`, {
      headers: { ...authHeaders(cfg.anonKey), Accept: "application/openapi+json, application/json" },
    });
  } catch (e) {
    throw new SourceError(`원본 프로젝트에 연결할 수 없습니다 (URL/네트워크/CORS 확인): ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      detail = j.message ?? j.msg ?? j.hint ?? detail;
    } catch {
      /* ignore */
    }
    if (res.status === 401 || res.status === 403) {
      throw new SourceError(
        `OpenAPI 스키마 조회가 거부되었습니다 (HTTP ${res.status}: ${detail}). ` +
          "프로젝트 설정에서 anon 키로 스키마 조회가 차단되어 있을 수 있습니다. " +
          "API 키가 올바른지 확인하거나, 스키마 조회가 허용된 키를 입력하세요.",
      );
    }
    throw new SourceError(`OpenAPI 스키마 조회 실패 (HTTP ${res.status}): ${detail}`);
  }
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch {
    throw new SourceError("OpenAPI 응답을 JSON으로 해석할 수 없습니다.");
  }
  return parseOpenApi(spec);
}

const clients = new Map<string, SupabaseClient>();

export function getSourceClient(cfg: SourceConfig): SupabaseClient {
  const key = `${normalizeUrl(cfg.url)}|${cfg.anonKey}`;
  let c = clients.get(key);
  if (!c) {
    c = createClient(normalizeUrl(cfg.url), cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `copier-${clients.size}` },
    });
    clients.set(key, c);
  }
  return c;
}

export async function countRows(cfg: SourceConfig, table: string): Promise<number | null> {
  const { count, error } = await getSourceClient(cfg).from(table).select("*", { count: "exact", head: true });
  if (error) throw new SourceError(`${table} 행 수 조회 실패: ${error.message}`);
  return count;
}

/** 한 페이지(최대 PAGE_SIZE행)를 읽습니다. PK가 있으면 PK 순으로 정렬합니다. */
export async function fetchPage(cfg: SourceConfig, table: TableDef, from: number, size = PAGE_SIZE): Promise<Record<string, unknown>[]> {
  let q = getSourceClient(cfg).from(table.name).select(buildSelectList(table));
  for (const pk of table.primaryKey) q = q.order(pk, { ascending: true });
  const { data, error } = await q.range(from, from + size - 1);
  if (error) throw new SourceError(`${table.name} 읽기 실패 (offset ${from}): ${error.message}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
}
