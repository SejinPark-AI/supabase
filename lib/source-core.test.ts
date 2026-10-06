import { describe, expect, it } from "vitest";
import type { ColumnDef, TableDef } from "./ddl";
import {
  buildOrderParam,
  buildPageQuery,
  canonicalSourceUrl,
  checkCookieAccess,
  checkEnvAccess,
  decideEnvMode,
  decodeStoredKey,
  describeKeyKind,
  encodeStoredKey,
  isKnownTable,
  isPlausibleApiKey,
  isSafeTableName,
  parseContentRangeTotal,
  projectRefFromUrl,
  sameSourceUrl,
  tablePath,
} from "./source-core";

const col = (over: Partial<ColumnDef> & { name: string }): ColumnDef => ({ format: "text", notNull: false, isPk: false, ...over });
const table = (name: string, columns: ColumnDef[]): TableDef => ({
  name,
  columns,
  primaryKey: columns.filter((c) => c.isPk).map((c) => c.name),
  foreignKeys: [],
  likelyView: false,
});

const jwt = (payload: object) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;

describe("canonicalSourceUrl / sameSourceUrl", () => {
  it("normalizes case, default port, trailing slash", () => {
    expect(canonicalSourceUrl(" HTTPS://Abc.Supabase.CO:443/ ")).toBe("https://abc.supabase.co");
    expect(canonicalSourceUrl("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
    expect(canonicalSourceUrl("https://h.example.com/base//")).toBe("https://h.example.com/base");
  });
  it("rejects non-http, credentials, query, hash, garbage", () => {
    for (const bad of ["", "abc", "ftp://x.supabase.co", "javascript:alert(1)", "https://u:p@x.supabase.co", "https://x.supabase.co?a=1", "https://x.supabase.co#f", "https://x.supabase.co?", 42, null]) {
      expect(canonicalSourceUrl(bad)).toBeNull();
    }
  });
  it("compares after normalization", () => {
    expect(sameSourceUrl("https://abc.supabase.co/", "https://ABC.supabase.co")).toBe(true);
    expect(sameSourceUrl("https://abc.supabase.co", "https://abc.supabase.co.evil.com")).toBe(false);
    expect(sameSourceUrl("https://abc.supabase.co", "http://abc.supabase.co")).toBe(false);
    expect(sameSourceUrl("https://abc.supabase.co", "https://abc.supabase.co:8443")).toBe(false);
    expect(sameSourceUrl("https://abc.supabase.co@evil.com", "https://abc.supabase.co")).toBe(false);
    expect(sameSourceUrl("", "")).toBe(false);
    expect(sameSourceUrl("bad", "bad")).toBe(false);
  });
});

describe("projectRefFromUrl", () => {
  it("extracts ref from https://<ref>.supabase.co", () => {
    expect(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co/")).toBe("abcdefghijklmnopqrst");
  });
  it("returns null for other hosts / http / ports / paths", () => {
    expect(projectRefFromUrl("http://abc.supabase.co")).toBeNull();
    expect(projectRefFromUrl("https://abc.supabase.co:8443")).toBeNull();
    expect(projectRefFromUrl("https://abc.supabase.co/x")).toBeNull();
    expect(projectRefFromUrl("https://abc.supabase.co.evil.com")).toBeNull();
    expect(projectRefFromUrl("https://a.b.supabase.co")).toBeNull();
    expect(projectRefFromUrl("http://127.0.0.1:54321")).toBeNull();
    expect(projectRefFromUrl("https://db.example.com")).toBeNull();
  });
});

describe("decideEnvMode", () => {
  it("unavailable without key", () => {
    expect(decideEnvMode({ envUrl: "https://abc.supabase.co", hasKey: false, allowUnverified: true }).available).toBe(false);
  });
  it("unavailable without valid url", () => {
    expect(decideEnvMode({ envUrl: undefined, hasKey: true, allowUnverified: true }).available).toBe(false);
    expect(decideEnvMode({ envUrl: "not a url", hasKey: true, allowUnverified: true }).available).toBe(false);
  });
  it("supabase.co → project-access gate", () => {
    expect(decideEnvMode({ envUrl: "https://abc.supabase.co/", hasKey: true, allowUnverified: false })).toEqual({
      available: true,
      url: "https://abc.supabase.co",
      ref: "abc",
      gate: "project-access",
    });
    // ALLOW_UNVERIFIED가 있어도 supabase.co는 계정 확인을 생략하지 않음
    expect(decideEnvMode({ envUrl: "https://abc.supabase.co", hasKey: true, allowUnverified: true })).toMatchObject({ gate: "project-access" });
  });
  it("self-hosted requires ALLOW_UNVERIFIED_SERVICE_ROLE", () => {
    const refused = decideEnvMode({ envUrl: "http://127.0.0.1:54321", hasKey: true, allowUnverified: false });
    expect(refused.available).toBe(false);
    expect(!refused.available && refused.reason).toContain("ALLOW_UNVERIFIED_SERVICE_ROLE");
    expect(decideEnvMode({ envUrl: "http://127.0.0.1:54321", hasKey: true, allowUnverified: true })).toEqual({
      available: true,
      url: "http://127.0.0.1:54321",
      ref: null,
      gate: "unverified",
    });
  });
});

describe("checkEnvAccess", () => {
  const decision = decideEnvMode({ envUrl: "https://abc.supabase.co", hasKey: true, allowUnverified: false });
  it("refuses when UI URL differs (overridden)", () => {
    const r = checkEnvAccess({ decision, expectUrl: "https://other.supabase.co", hasToken: true, accessibleRefs: ["abc"] });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(checkEnvAccess({ decision, expectUrl: null, hasToken: true, accessibleRefs: ["abc"] })).toMatchObject({ ok: false, status: 409 });
  });
  it("requires login", () => {
    expect(checkEnvAccess({ decision, expectUrl: "https://abc.supabase.co", hasToken: false, accessibleRefs: null })).toMatchObject({ ok: false, status: 401 });
  });
  it("requires the account to see the project", () => {
    expect(checkEnvAccess({ decision, expectUrl: "https://abc.supabase.co", hasToken: true, accessibleRefs: ["xyz"] })).toMatchObject({ ok: false, status: 403 });
    expect(checkEnvAccess({ decision, expectUrl: "https://ABC.supabase.co/", hasToken: true, accessibleRefs: ["xyz", "abc"] })).toEqual({
      ok: true,
      url: "https://abc.supabase.co",
    });
  });
  it("unverified gate skips login but still checks URL", () => {
    const d = decideEnvMode({ envUrl: "http://localhost:54321", hasKey: true, allowUnverified: true });
    expect(checkEnvAccess({ decision: d, expectUrl: "http://localhost:54321/", hasToken: false, accessibleRefs: null })).toEqual({ ok: true, url: "http://localhost:54321" });
    expect(checkEnvAccess({ decision: d, expectUrl: "http://evil:54321", hasToken: false, accessibleRefs: null }).ok).toBe(false);
  });
  it("unavailable decision is refused", () => {
    const d = decideEnvMode({ envUrl: "https://abc.supabase.co", hasKey: false, allowUnverified: false });
    expect(checkEnvAccess({ decision: d, expectUrl: "https://abc.supabase.co", hasToken: true, accessibleRefs: ["abc"] }).ok).toBe(false);
  });
});

describe("checkCookieAccess / stored key encoding", () => {
  const key = jwt({ role: "service_role" });
  it("round-trips url+key", () => {
    const enc = encodeStoredKey({ url: "https://abc.supabase.co", key });
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeStoredKey(enc)).toEqual({ url: "https://abc.supabase.co", key });
  });
  it("rejects garbage", () => {
    expect(decodeStoredKey(undefined)).toBeNull();
    expect(decodeStoredKey("%%%")).toBeNull();
    expect(decodeStoredKey(encodeStoredKey({ url: "ftp://x", key }))).toBeNull();
    expect(decodeStoredKey(encodeStoredKey({ url: "https://abc.supabase.co", key: "bad key with spaces" }))).toBeNull();
  });
  it("only allows the bound URL", () => {
    const stored = { url: "https://abc.supabase.co" };
    expect(checkCookieAccess({ stored, expectUrl: "https://abc.supabase.co/" })).toEqual({ ok: true, url: "https://abc.supabase.co" });
    expect(checkCookieAccess({ stored, expectUrl: "https://evil.example.com" })).toMatchObject({ ok: false, status: 409 });
    expect(checkCookieAccess({ stored: null, expectUrl: "https://abc.supabase.co" })).toMatchObject({ ok: false });
  });
});

describe("key helpers", () => {
  it("describeKeyKind", () => {
    expect(describeKeyKind(jwt({ role: "service_role" }))).toBe("service_role");
    expect(describeKeyKind(jwt({ role: "anon" }))).toBe("anon");
    expect(describeKeyKind(jwt({ role: "authenticated" }))).toBe("jwt-other");
    expect(describeKeyKind("sb_secret_abcdefghijklmnop")).toBe("secret");
    expect(describeKeyKind("sb_publishable_abcdefghijklmnop")).toBe("publishable");
    expect(describeKeyKind("whatever-key-1234567890")).toBe("unknown");
  });
  it("isPlausibleApiKey", () => {
    expect(isPlausibleApiKey(jwt({ role: "service_role" }))).toBe(true);
    expect(isPlausibleApiKey("short")).toBe(false);
    expect(isPlausibleApiKey("abc def ghi jkl mno pqr")).toBe(false);
    expect(isPlausibleApiKey("abcdefghijklmnopqrstuv\r\nX-Evil: 1")).toBe(false);
  });
});

describe("table name validation", () => {
  it("isSafeTableName", () => {
    expect(isSafeTableName("users")).toBe(true);
    expect(isSafeTableName("주문 내역")).toBe(true);
    expect(isSafeTableName("")).toBe(false);
    expect(isSafeTableName(".")).toBe(false);
    expect(isSafeTableName("..")).toBe(false);
    expect(isSafeTableName("a\nb")).toBe(false);
    expect(isSafeTableName("x".repeat(64))).toBe(false);
    expect(isSafeTableName("가".repeat(22))).toBe(false); // 66 bytes
    expect(isSafeTableName(123)).toBe(false);
  });
  it("isKnownTable requires membership", () => {
    expect(isKnownTable("users", ["users", "posts"])).toBe(true);
    expect(isKnownTable("../rpc/x", ["users"])).toBe(false);
    expect(isKnownTable("Users", ["users"])).toBe(false);
  });
  it("tablePath encodes", () => {
    expect(tablePath("users")).toBe("/rest/v1/users");
    expect(tablePath("a/b?c#d")).toBe("/rest/v1/a%2Fb%3Fc%23d");
    expect(() => tablePath("..")).toThrow();
  });
});

describe("shared page query builder", () => {
  const t = table("t", [col({ name: "id", format: "bigint", isPk: true }), col({ name: "a b", isPk: true }), col({ name: "amt", format: "numeric" })]);
  it("order by PK with quoting", () => {
    expect(buildOrderParam(t)).toBe('id.asc,"a b".asc');
    expect(buildOrderParam(table("n", [col({ name: "x" })]))).toBeNull();
  });
  it("builds select/order/offset/limit", () => {
    const p = new URLSearchParams(buildPageQuery(t, 2000, 1000));
    expect(p.get("select")).toBe('id::text,"a b",amt::text');
    expect(p.get("order")).toBe('id.asc,"a b".asc');
    expect(p.get("offset")).toBe("2000");
    expect(p.get("limit")).toBe("1000");
    expect(new URLSearchParams(buildPageQuery(table("n", [col({ name: "x" })]), 0)).get("order")).toBeNull();
  });
  it("parseContentRangeTotal", () => {
    expect(parseContentRangeTotal("0-9/123")).toBe(123);
    expect(parseContentRangeTotal("*/0")).toBe(0);
    expect(parseContentRangeTotal("0-9/*")).toBeNull();
    expect(parseContentRangeTotal(null)).toBeNull();
  });
});
