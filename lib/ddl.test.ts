import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  buildAddForeignKey,
  buildCreateEnum,
  buildCreateTable,
  buildInsertSql,
  buildMigrationPlan,
  buildPreviewSql,
  buildResetSequences,
  buildSelectList,
  chunkRows,
  dollarQuote,
  mapColumnType,
  normalizeBaseType,
  parseOpenApi,
  pickDollarTag,
  qualified,
  quoteIdent,
  renderDefault,
  sqlLiteral,
  topoSortTables,
  truncateIdent,
  type ColumnDef,
  type TableDef,
} from "./ddl";

const col = (over: Partial<ColumnDef> & { name: string }): ColumnDef => ({
  format: "text",
  notNull: false,
  isPk: false,
  ...over,
});

const table = (name: string, columns: ColumnDef[], over: Partial<TableDef> = {}): TableDef => ({
  name,
  columns,
  primaryKey: columns.filter((c) => c.isPk).map((c) => c.name),
  foreignKeys: columns.filter((c) => c.fk).map((c) => ({ column: c.name, refTable: c.fk!.table, refColumn: c.fk!.column })),
  likelyView: false,
  ...over,
});

const SPEC = {
  swagger: "2.0",
  paths: {
    "/": { get: {} },
    "/users": { get: {}, post: {}, patch: {}, delete: {} },
    "/posts": { get: {}, post: {}, patch: {}, delete: {} },
    "/post_stats": { get: {} },
    "/rpc/do_thing": { post: {} },
  },
  definitions: {
    users: {
      required: ["id", "email"],
      properties: {
        id: { description: "Note:\nThis is a Primary Key.<pk/>", format: "uuid", type: "string", default: "gen_random_uuid()" },
        email: { format: "character varying", type: "string", maxLength: 255 },
        mood: { format: "public.mood", type: "string", enum: ["happy", "sad"] },
        tags: { format: "text[]", type: "array", items: { type: "string" } },
        created_at: { format: "timestamp with time zone", type: "string", default: "now()" },
      },
    },
    posts: {
      required: ["id", "author_id"],
      properties: {
        id: { description: "Note:\nThis is a Primary Key.<pk/>", format: "bigint", type: "integer", default: "nextval('posts_id_seq'::regclass)" },
        author_id: {
          description: "Note:\nThis is a Foreign Key to `users.id`.<fk table='users' column='id'/>",
          format: "uuid",
          type: "string",
        },
        body: { format: "jsonb" },
        status: { format: "text", type: "string", default: "draft" },
      },
    },
    post_stats: {
      properties: {
        author_id: { format: "uuid", type: "string" },
        n: { format: "bigint", type: "integer" },
      },
    },
  },
};

describe("quoting", () => {
  it("quotes identifiers and escapes double quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(qualified("My Table")).toBe('"public"."My Table"');
  });
  it("escapes string literals", () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
  });
  it("truncates identifiers to 63 bytes", () => {
    expect(truncateIdent("a".repeat(100))).toHaveLength(63);
    expect(new TextEncoder().encode(truncateIdent("한".repeat(40))).length).toBeLessThanOrEqual(63);
  });
});

describe("dollar-quote tag", () => {
  it("never appears in payload", () => {
    const payload = '{"x":"$j_aaaaaa$"}';
    let i = 0;
    // 첫 시도는 'aaaaaa' 를 생성하도록 rng 조작 → 충돌 → 다음 시도
    const seq = [0, 0, 0, 0, 0, 0];
    const rng = () => (i < seq.length ? seq[i++] : 0.5);
    const tag = pickDollarTag(payload, rng);
    expect(tag).not.toBe("$j_aaaaaa$");
    expect(payload.includes(tag)).toBe(false);
    expect(tag).toMatch(/^\$j_[a-z0-9]+\$$/);
  });
  it("wraps body", () => {
    const q = dollarQuote("select 1");
    expect(q).toMatch(/^\$j_[a-z0-9]+\$select 1\$j_[a-z0-9]+\$$/);
  });
});

describe("parseOpenApi", () => {
  const { tables } = parseOpenApi(SPEC);
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));

  it("parses tables sorted and ignores rpc", () => {
    expect(tables.map((t) => t.name)).toEqual(["post_stats", "posts", "users"]);
  });
  it("detects pk, fk, required, enum", () => {
    expect(byName.users.primaryKey).toEqual(["id"]);
    expect(byName.users.columns.find((c) => c.name === "email")!.notNull).toBe(true);
    expect(byName.users.columns.find((c) => c.name === "mood")!.enumValues).toEqual(["happy", "sad"]);
    expect(byName.posts.foreignKeys).toEqual([{ column: "author_id", refTable: "users", refColumn: "id" }]);
  });
  it("flags likely views", () => {
    expect(byName.post_stats.likelyView).toBe(true);
    expect(byName.users.likelyView).toBe(false);
  });
  it("rejects bad specs", () => {
    expect(() => parseOpenApi(null)).toThrow();
    expect(() => parseOpenApi({ paths: {} })).toThrow(/definitions/);
  });
  it("supports composite primary keys", () => {
    const { tables: t } = parseOpenApi({
      definitions: {
        m: {
          properties: {
            a: { format: "uuid", description: "<pk/>" },
            b: { format: "integer", description: "<pk/>" },
          },
        },
      },
    });
    expect(t[0].primaryKey).toEqual(["a", "b"]);
    expect(buildCreateTable(t[0]).sql).toContain('primary key ("a", "b")');
  });
});

describe("type mapping", () => {
  it("normalizes base types and aliases", () => {
    expect(normalizeBaseType("int8")).toBe("bigint");
    expect(normalizeBaseType("timestamptz")).toBe("timestamp with time zone");
    expect(normalizeBaseType("character varying(20)")).toBe("character varying(20)");
    expect(normalizeBaseType("numeric(10, 2)")).toBe("numeric(10,2)");
    expect(normalizeBaseType("geometry")).toBeNull();
    expect(normalizeBaseType("text; drop table x")).toBeNull();
  });
  it("maps scalars", () => {
    expect(mapColumnType(col({ name: "a", format: "uuid" }), "t").sql).toBe("uuid");
    expect(mapColumnType(col({ name: "a", format: "character varying", maxLength: 50 }), "t").sql).toBe("character varying(50)");
    expect(mapColumnType(col({ name: "a", format: "jsonb" }), "t").sql).toBe("jsonb");
  });
  it("maps arrays", () => {
    expect(mapColumnType(col({ name: "a", format: "text[]", jsonType: "array" }), "t").sql).toBe("text[]");
    expect(mapColumnType(col({ name: "a", format: "ARRAY", jsonType: "array", itemsFormat: "integer" }), "t").sql).toBe("integer[]");
    const unk = mapColumnType(col({ name: "a", format: "ARRAY", jsonType: "array" }), "t");
    expect(unk.sql).toBe("jsonb");
    expect(unk.warnings.length).toBe(1);
  });
  it("maps enums", () => {
    const m = mapColumnType(col({ name: "mood", format: "public.mood", enumValues: ["a", "b"] }), "t");
    expect(m.sql).toBe('"public"."mood"');
    expect(m.enumType).toEqual({ name: "mood", values: ["a", "b"] });
    const u = mapColumnType(col({ name: "kind", format: "USER-DEFINED", enumValues: ["x"] }), "items");
    expect(u.enumType!.name).toBe("items_kind");
    const arr = mapColumnType(col({ name: "moods", format: "mood[]", jsonType: "array", enumValues: ["a"] }), "t");
    expect(arr.sql).toBe('"public"."mood"[]');
  });
  it("falls back for unknown types with warning", () => {
    const m = mapColumnType(col({ name: "g", format: "USER-DEFINED", jsonType: "string" }), "t");
    expect(m.sql).toBe("text");
    expect(m.warnings[0]).toMatch(/text/);
  });
  it("creates enum via DO block with escaped values", () => {
    const sql = buildCreateEnum({ name: "mood", values: ["it's", "ok"] });
    expect(sql).toMatch(/^do \$j_/);
    expect(sql).toContain(`create type "public"."mood" as enum ('it''s', 'ok')`);
    expect(sql).toContain("if not exists");
  });
});

describe("defaults", () => {
  const r = (over: Partial<ColumnDef>) => {
    const c = col({ name: "c", ...over });
    return renderDefault(c, mapColumnType(c, "t"), "t");
  };
  it("converts nextval to identity for integers", () => {
    expect(r({ format: "bigint", default: "nextval('t_id_seq'::regclass)" })).toEqual({ identity: true });
    expect(r({ format: "text", default: "nextval('x')" }).warning).toBeTruthy();
  });
  it("keeps safe expressions and literals", () => {
    expect(r({ format: "timestamp with time zone", default: "now()" }).expr).toBe("now()");
    expect(r({ format: "uuid", default: "extensions.uuid_generate_v4()" }).expr).toBe("gen_random_uuid()");
    expect(r({ format: "text", default: "'abc'::text" }).expr).toBe("'abc'::text");
    expect(r({ format: "text", default: "draft" }).expr).toBe("'draft'");
    expect(r({ format: "integer", default: 0 }).expr).toBe("0");
    expect(r({ format: "boolean", default: false }).expr).toBe("false");
    expect(r({ format: "boolean", default: "true" }).expr).toBe("true");
    expect(r({ format: "jsonb", default: "'{}'::jsonb" }).expr).toBe("'{}'::jsonb");
  });
  it("skips unsafe expressions with warning", () => {
    const d = r({ format: "text", default: "my_func(1)" });
    expect(d.expr).toBeUndefined();
    expect(d.warning).toMatch(/건너뜁니다/);
  });
});

describe("buildCreateTable", () => {
  const { tables } = parseOpenApi(SPEC);
  const posts = tables.find((t) => t.name === "posts")!;
  const users = tables.find((t) => t.name === "users")!;
  it("generates create table with identity, not null, pk", () => {
    const { sql } = buildCreateTable(posts);
    expect(sql).toContain('create table if not exists "public"."posts"');
    expect(sql).toContain('"id" bigint generated by default as identity not null');
    expect(sql).toContain('"author_id" uuid not null');
    expect(sql).toContain(`"status" text default 'draft'`);
    expect(sql).toContain('primary key ("id")');
    expect(sql).not.toContain("references"); // FK는 별도 문
  });
  it("collects enum types", () => {
    expect(buildCreateTable(users).enumTypes).toEqual([{ name: "mood", values: ["happy", "sad"] }]);
  });
  it("builds idempotent FK statement", () => {
    const sql = buildAddForeignKey("posts", "author_id", "users", "id");
    expect(sql).toContain('add constraint "posts_author_id_fkey"');
    expect(sql).toContain('references "public"."users" ("id")');
    expect(sql).toContain("exception when duplicate_object");
  });
});

describe("topoSortTables", () => {
  it("orders by dependency", () => {
    const a = table("a", [col({ name: "id", isPk: true })]);
    const b = table("b", [col({ name: "a_id", fk: { table: "a", column: "id" } })]);
    const c = table("c", [col({ name: "b_id", fk: { table: "b", column: "id" } })]);
    expect(topoSortTables([c, b, a]).order).toEqual(["a", "b", "c"]);
  });
  it("ignores self references and unknown tables", () => {
    const t = table("t", [col({ name: "parent", fk: { table: "t", column: "id" } }), col({ name: "x", fk: { table: "zzz", column: "id" } })]);
    expect(topoSortTables([t])).toEqual({ order: ["t"], cyclic: [] });
  });
  it("handles cycles gracefully", () => {
    const x = table("x", [col({ name: "y_id", fk: { table: "y", column: "id" } })]);
    const y = table("y", [col({ name: "x_id", fk: { table: "x", column: "id" } })]);
    const z = table("z", [col({ name: "id" })]);
    const r = topoSortTables([x, y, z]);
    expect(r.order).toEqual(["z", "x", "y"]);
    expect(r.cyclic).toEqual(["x", "y"]);
  });
});

describe("chunkRows", () => {
  it("splits by row count", () => {
    const rows = Array.from({ length: 1201 }, (_, i) => ({ i }));
    const chunks = chunkRows(rows, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
  });
  it("splits by byte size", () => {
    const rows = Array.from({ length: 10 }, () => ({ s: "x".repeat(100) }));
    const chunks = chunkRows(rows, 500, 350);
    expect(chunks.every((c) => new TextEncoder().encode(JSON.stringify(c)).length <= 350)).toBe(true);
    expect(chunks.flat()).toHaveLength(10);
  });
  it("puts oversized rows alone", () => {
    const rows = [{ s: "a" }, { s: "x".repeat(1000) }, { s: "b" }];
    expect(chunkRows(rows, 500, 100).map((c) => c.length)).toEqual([1, 1, 1]);
  });
  it("handles empty input", () => {
    expect(chunkRows([])).toEqual([]);
  });
});

describe("buildInsertSql", () => {
  const t = table("t", [col({ name: "id", format: "bigint", isPk: true }), col({ name: 'na"me' })]);
  it("uses json_populate_recordset with explicit columns and safe tag", () => {
    const rows = [{ id: 1, 'na"me': "it's $j_x$ fine" }];
    const sql = buildInsertSql(t, rows, { replicaRole: true });
    expect(sql.startsWith("set session_replication_role = replica;")).toBe(true);
    expect(sql).toContain(`insert into "public"."t" ("id", "na""me") overriding system value`);
    expect(sql).toContain(`json_populate_recordset(null::"public"."t", $j_`);
    const tag = sql.match(/(\$j_[a-z0-9]+\$)\[/)![1];
    const payload = sql.split(tag)[1];
    expect(JSON.parse(payload)).toEqual(rows);
    expect(sql.trim().endsWith("reset session_replication_role;")).toBe(true);
  });
  it("omits replica role and adds on conflict", () => {
    const sql = buildInsertSql(t, [], { replicaRole: false, onConflictDoNothing: true });
    expect(sql).not.toContain("session_replication_role");
    expect(sql).toContain("on conflict do nothing;");
  });
});

describe("sequences", () => {
  it("builds setval DO block", () => {
    const sql = buildResetSequences("my'table");
    expect(sql).toContain("pg_get_serial_sequence('\"public\".\"my''table\"', a.attname)");
    expect(sql).toContain("setval(r.seq::regclass, 1, false)");
    expect(sql).toContain("setval(r.seq::regclass, m, true)");
  });
});

describe("buildMigrationPlan", () => {
  const { tables } = parseOpenApi(SPEC);
  it("schema+data skip mode", () => {
    const plan = buildMigrationPlan(tables, ["users", "posts"], DEFAULT_OPTIONS);
    expect(plan.order).toEqual(["users", "posts"]);
    const kinds = plan.pre.map((s) => s.kind);
    expect(kinds).toEqual(["enum", "create", "create", "fk", "rls", "rls"]);
    expect(plan.post.map((s) => s.kind)).toEqual(["sequence", "sequence"]);
  });
  it("drop mode drops in reverse order and skips truncate", () => {
    const plan = buildMigrationPlan(tables, ["users", "posts"], { ...DEFAULT_OPTIONS, ifExists: "drop", truncate: true });
    const drops = plan.pre.filter((s) => s.kind === "drop").map((s) => s.table);
    expect(drops).toEqual(["posts", "users"]);
    expect(plan.pre.some((s) => s.kind === "truncate")).toBe(false);
  });
  it("data-only mode with truncate", () => {
    const plan = buildMigrationPlan(tables, ["posts"], { ...DEFAULT_OPTIONS, mode: "data", truncate: true });
    expect(plan.pre.map((s) => s.kind)).toEqual(["truncate"]);
    expect(plan.pre[0].sql).toBe('truncate table "public"."posts" restart identity;');
  });
  it("warns about FKs to unselected tables", () => {
    const plan = buildMigrationPlan(tables, ["posts"], DEFAULT_OPTIONS);
    expect(plan.pre.some((s) => s.kind === "fk")).toBe(false);
    expect(plan.warnings.some((w) => w.includes("FK"))).toBe(true);
  });
  it("renders preview", () => {
    const plan = buildMigrationPlan(tables, ["users", "posts"], DEFAULT_OPTIONS);
    const sql = buildPreviewSql(plan, tables, DEFAULT_OPTIONS, { users: 3, posts: null });
    expect(sql).toContain("$json$[ ...행 데이터... ]$json$");
    expect(sql).toContain("-- users: 3행");
    expect(sql).toContain("-- posts: ?행");
  });
});

describe("buildSelectList", () => {
  it("returns * when no casts needed", () => {
    expect(buildSelectList(table("t", [col({ name: "a" })]))).toBe("*");
  });
  it("casts bigint/numeric to text", () => {
    const t = table("t", [col({ name: "id", format: "bigint" }), col({ name: "a b" }), col({ name: "amt", format: "numeric" })]);
    expect(buildSelectList(t)).toBe('id::text,"a b",amt::text');
  });
});
