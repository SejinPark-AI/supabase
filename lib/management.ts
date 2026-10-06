/**
 * Supabase Management API 헬퍼 (서버 전용).
 * Personal Access Token은 httpOnly 쿠키로만 보관되며 클라이언트 JS로 전달되지 않습니다.
 */
import "server-only";

export const MANAGEMENT_API = "https://api.supabase.com/v1";
export const TOKEN_COOKIE = "sb_mgmt_token";
export const TOKEN_MAX_AGE = 60 * 60 * 8; // 8시간

export class ManagementError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ManagementError";
    this.status = status;
  }
}

export interface ProjectSummary {
  ref: string;
  name: string;
  region: string;
  status: string;
  organizationId?: string;
  createdAt?: string;
}

/** 프로젝트 ref 형식 검증 (관대하게: 소문자/숫자/하이픈) */
export function isValidRef(ref: unknown): ref is string {
  return typeof ref === "string" && ref.length > 0 && ref.length <= 64 && /^[a-z0-9-]+$/.test(ref);
}

/** 토큰 형식 기본 검증 */
export function isPlausibleToken(token: unknown): token is string {
  return typeof token === "string" && token.length >= 10 && token.length <= 512 && /^[A-Za-z0-9_\-.]+$/.test(token);
}

function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const k of ["message", "error", "msg", "error_description"]) {
      if (typeof b[k] === "string" && b[k]) return b[k] as string;
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 2000);
  return fallback;
}

async function mgmtFetch(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${MANAGEMENT_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new ManagementError(`Management API에 연결할 수 없습니다: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* 텍스트 그대로 */
  }
  if (!res.ok) {
    let msg = extractMessage(body, `HTTP ${res.status}`);
    if (res.status === 401) msg = `인증 실패 (토큰이 유효하지 않거나 만료됨): ${msg}`;
    else if (res.status === 403) msg = `권한 없음: ${msg}`;
    else if (res.status === 404) msg = `찾을 수 없음 (프로젝트 ref 확인): ${msg}`;
    else if (res.status === 429) msg = `요청 한도 초과 (잠시 후 다시 시도): ${msg}`;
    throw new ManagementError(msg, res.status);
  }
  return body;
}

export async function listProjects(token: string): Promise<ProjectSummary[]> {
  const body = await mgmtFetch(token, "/projects");
  if (!Array.isArray(body)) throw new ManagementError("프로젝트 목록 응답 형식이 올바르지 않습니다.", 502);
  return body
    .map((p: Record<string, unknown>) => ({
      ref: String(p.ref ?? p.id ?? ""),
      name: String(p.name ?? ""),
      region: String(p.region ?? ""),
      status: String(p.status ?? ""),
      organizationId: p.organization_id ? String(p.organization_id) : undefined,
      createdAt: p.created_at ? String(p.created_at) : undefined,
    }))
    .filter((p) => p.ref)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function runQuery(token: string, ref: string, query: string): Promise<unknown> {
  if (!isValidRef(ref)) throw new ManagementError("프로젝트 ref 형식이 올바르지 않습니다.", 400);
  return mgmtFetch(token, `/projects/${ref}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: TOKEN_MAX_AGE,
  };
}

/** 간단한 CSRF 방어: Origin 헤더가 있으면 Host와 일치해야 합니다. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
