/**
 * 순수 함수 모음: PostgREST OpenAPI 파싱, 타입 매핑, DDL/DML 생성, 위상 정렬, 배치 분할.
 * 브라우저/서버/테스트 어디서든 동작하도록 외부 의존성이 없습니다.
 */

export const SCHEMA = "public";

// ---------------------------------------------------------------------------
// 타입 정의
// ---------------------------------------------------------------------------

export interface ForeignKeyRef {
  table: string;
  column: string;
}

export interface ColumnDef {
  name: string;
  /** PostgREST가 제공하는 Postgres 타입 문자열 (예: "uuid", "text[]", "USER-DEFINED") */
  format: string;
  /** JSON schema type (string, integer, number, boolean, array, object) */
  jsonType?: string;
  /** 배열 요소 정보 (type: array인 경우) */
  itemsFormat?: string;
  itemsType?: string;
  enumValues?: string[];
  notNull: boolean;
  default?: unknown;
  isPk: boolean;
  fk?: ForeignKeyRef;
  maxLength?: number;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  primaryKey: string[];
  foreignKeys: { column: string; refTable: string; refColumn: string }[];
  /** PK가 없고 쓰기 메서드가 노출되지 않음 → 뷰일 가능성이 높음 */
  likelyView: boolean;
}

export interface ParseResult {
  tables: TableDef[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// SQL 기본 유틸
// ---------------------------------------------------------------------------

/** 식별자 인용: 큰따옴표로 감싸고 내부 큰따옴표는 두 번 씁니다. */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** 스키마 한정 테이블 이름 */
export function qualified(table: string, schema: string = SCHEMA): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** 문자열 리터럴 (standard_conforming_strings = on 가정) */
export function sqlLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Postgres 식별자 최대 길이(63바이트)에 맞게 자릅니다. */
export function truncateIdent(name: string, max = 63): string {
  const enc = new TextEncoder();
  if (enc.encode(name).length <= max) return name;
  let out = "";
  for (const ch of name) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

/**
 * payload 안에 등장하지 않는 dollar-quote 태그를 생성합니다. 예: $j_ab12cd$
 * rng는 테스트를 위해 주입 가능합니다.
 */
export function pickDollarTag(payload: string, rng: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 1000; attempt++) {
    const len = 6 + Math.min(attempt, 20);
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length) % alphabet.length];
    const tag = `$j_${s}$`;
    if (!payload.includes(tag)) return tag;
  }
  throw new Error("dollar-quote 태그를 생성하지 못했습니다.");
}

/** body를 안전한 dollar-quote로 감쌉니다. */
export function dollarQuote(body: string, rng?: () => number): string {
  const tag = pickDollarTag(body, rng);
  return `${tag}${body}${tag}`;
}

// ---------------------------------------------------------------------------
// OpenAPI 파싱
// ---------------------------------------------------------------------------

interface OpenApiProperty {
  format?: string;
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: { type?: string; format?: string; enum?: unknown[] };
  maxLength?: number;
}

interface OpenApiDefinition {
  required?: string[];
  properties?: Record<string, OpenApiProperty>;
}

const FK_RE = /<fk\s+table=['"]([^'"]+)['"]\s+column=['"]([^'"]+)['"]\s*\/>/;

export function parseOpenApi(spec: unknown): ParseResult {
  const warnings: string[] = [];
  if (!spec || typeof spec !== "object") {
    throw new Error("OpenAPI 응답이 객체가 아닙니다.");
  }
  const s = spec as { definitions?: Record<string, OpenApiDefinition>; paths?: Record<string, Record<string, unknown>> };
  if (!s.definitions || typeof s.definitions !== "object") {
    throw new Error("OpenAPI 응답에 definitions가 없습니다. (스키마 조회 권한이 없거나 노출된 테이블이 없습니다)");
  }
  const paths = s.paths ?? {};
  const tables: TableDef[] = [];

  for (const [name, def] of Object.entries(s.definitions)) {
    const required = new Set(def.required ?? []);
    const props = def.properties ?? {};
    const columns: ColumnDef[] = [];
    for (const [colName, p] of Object.entries(props)) {
      const desc = p.description ?? "";
      const fkMatch = desc.match(FK_RE);
      const enumSrc = p.enum ?? p.items?.enum;
      const col: ColumnDef = {
        name: colName,
        format: p.format ?? "",
        jsonType: p.type,
        itemsFormat: p.items?.format,
        itemsType: p.items?.type,
        enumValues: Array.isArray(enumSrc) ? enumSrc.map((v) => String(v)) : undefined,
        notNull: required.has(colName),
        default: p.default,
        isPk: desc.includes("<pk/>"),
        fk: fkMatch ? { table: fkMatch[1], column: fkMatch[2] } : undefined,
        maxLength: typeof p.maxLength === "number" ? p.maxLength : undefined,
      };
      columns.push(col);
    }
    const primaryKey = columns.filter((c) => c.isPk).map((c) => c.name);
    const foreignKeys = columns
      .filter((c) => c.fk)
      .map((c) => ({ column: c.name, refTable: c.fk!.table, refColumn: c.fk!.column }));
    const path = paths[`/${name}`];
    const writable = !!path && ["post", "patch", "delete"].some((m) => m in path);
    const likelyView = primaryKey.length === 0 && !writable;
    if (columns.length === 0) warnings.push(`${name}: 컬럼 정보가 없습니다.`);
    tables.push({ name, columns, primaryKey, foreignKeys, likelyView });
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return { tables, warnings };
}

// ---------------------------------------------------------------------------
// 타입 매핑
// ---------------------------------------------------------------------------

const KNOWN_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "boolean",
  "text",
  "character varying",
  "character",
  "uuid",
  "json",
  "jsonb",
  "date",
  "time without time zone",
  "time with time zone",
  "timestamp without time zone",
  "timestamp with time zone",
  "interval",
  "bytea",
  "inet",
  "cidr",
  "macaddr",
  "money",
  "tsvector",
  "xml",
  "oid",
  "point",
]);

const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  decimal: "numeric",
  bool: "boolean",
  varchar: "character varying",
  char: "character",
  bpchar: "character",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
};

export const INTEGER_TYPES = new Set(["smallint", "integer", "bigint"]);
const TEXTISH_TYPES = new Set(["text", "character varying", "character"]);

/** "int8", "character varying(255)" 등을 정규화. 알 수 없으면 null */
export function normalizeBaseType(format: string): string | null {
  const f = format.trim().toLowerCase();
  const m = f.match(/^([a-z][a-z0-9 _]*?)\s*(\(\s*\d+\s*(?:,\s*\d+\s*)?\))?$/);
  if (!m) return null;
  const base = TYPE_ALIASES[m[1]] ?? m[1];
  if (!KNOWN_TYPES.has(base)) return null;
  return base + (m[2] ? m[2].replace(/\s+/g, "") : "");
}

export interface EnumTypeDef {
  name: string;
  values: string[];
}

export interface MappedType {
  sql: string;
  /** 기본 타입(배열/수식어 제외) — 기본값 판단용 */
  base: string;
  isArray: boolean;
  enumType?: EnumTypeDef;
  warnings: string[];
}

function enumTypeName(format: string, table: string, column: string): string {
  let f = format.trim().replace(/\[\]$/, "");
  if (!f || /^(USER-DEFINED|ARRAY)$/i.test(f)) return `${table}_${column}`;
  const parts = f.split(".");
  f = parts[parts.length - 1].replace(/^"|"$/g, "");
  return f || `${table}_${column}`;
}

/** OpenAPI 컬럼 정보를 Postgres 타입으로 매핑합니다. */
export function mapColumnType(col: ColumnDef, table: string): MappedType {
  const warnings: string[] = [];
  const fmt = (col.format ?? "").trim();
  const isArray = fmt.endsWith("[]") || /^ARRAY$/i.test(fmt) || col.jsonType === "array";

  // 1) 일반 스칼라 타입
  if (!isArray) {
    const base = normalizeBaseType(fmt);
    if (base) {
      let sql = base;
      if ((base === "character varying" || base === "character") && col.maxLength && !base.includes("(")) {
        sql = `${base}(${col.maxLength})`;
      }
      return { sql, base: base.replace(/\(.*\)$/, ""), isArray: false, warnings };
    }
  }

  // 2) enum (스칼라 또는 배열)
  if (col.enumValues && col.enumValues.length > 0) {
    const name = truncateIdent(enumTypeName(fmt, table, col.name));
    const enumType = { name, values: col.enumValues };
    const sql = qualified(name) + (isArray ? "[]" : "");
    return { sql, base: "enum", isArray, enumType, warnings };
  }

  // 3) 배열
  if (isArray) {
    const inner = fmt.endsWith("[]") ? fmt.slice(0, -2) : col.itemsFormat ?? "";
    const base = inner ? normalizeBaseType(inner) : null;
    if (base) return { sql: `${base}[]`, base, isArray: true, warnings };
    warnings.push(`${table}.${col.name}: 배열 요소 타입(${fmt || "ARRAY"})을 알 수 없어 jsonb로 대체합니다.`);
    return { sql: "jsonb", base: "jsonb", isArray: false, warnings };
  }

  // 4) 알 수 없는 타입 → JSON 타입 기반 추정
  if (col.jsonType === "object") {
    warnings.push(`${table}.${col.name}: 타입 ${fmt || "?"}을(를) jsonb로 대체합니다.`);
    return { sql: "jsonb", base: "jsonb", isArray: false, warnings };
  }
  warnings.push(`${table}.${col.name}: 타입 ${fmt || "?"}을(를) 알 수 없어 text로 대체합니다.`);
  return { sql: "text", base: "text", isArray: false, warnings };
}

// ---------------------------------------------------------------------------
// 기본값
// ---------------------------------------------------------------------------

export interface DefaultResult {
  /** "default ..." 뒤에 들어갈 SQL 표현식 */
  expr?: string;
  identity?: boolean;
  warning?: string;
}

const SAFE_EXPRESSIONS: [RegExp, string | null][] = [
  [/^now\(\)$/i, "now()"],
  [/^current_timestamp$/i, "current_timestamp"],
  [/^current_date$/i, "current_date"],
  [/^current_time$/i, "current_time"],
  [/^localtimestamp$/i, "localtimestamp"],
  [/^(?:extensions\.)?gen_random_uuid\(\)$/i, "gen_random_uuid()"],
  [/^(?:extensions\.)?uuid_generate_v4\(\)$/i, "gen_random_uuid()"],
  [/^timezone\('utc'(?:::text)?,\s*now\(\)\)$/i, "timezone('utc'::text, now())"],
  [/^\(now\(\) at time zone 'utc'(?:::text)?\)$/i, "(now() at time zone 'utc'::text)"],
  [/^auth\.uid\(\)$/i, "auth.uid()"],
  [/^(true|false)$/i, null],
];

export function renderDefault(col: ColumnDef, mapped: MappedType, table: string): DefaultResult {
  const d = col.default;
  if (d === undefined || d === null) return {};
  const where = `${table}.${col.name}`;
  if (typeof d === "boolean") return { expr: d ? "true" : "false" };
  if (typeof d === "number") {
    return Number.isFinite(d) ? { expr: String(d) } : { warning: `${where}: 기본값 ${d}은(는) 건너뜁니다.` };
  }
  if (typeof d !== "string") {
    if (mapped.base === "jsonb" || mapped.base === "json") {
      return { expr: `${sqlLiteral(JSON.stringify(d))}::${mapped.base}` };
    }
    return { warning: `${where}: 기본값 형식을 알 수 없어 건너뜁니다.` };
  }

  const s = d.trim();
  if (/^nextval\(/i.test(s)) {
    if (!mapped.isArray && INTEGER_TYPES.has(mapped.base)) return { identity: true };
    return { warning: `${where}: 시퀀스 기본값(${s})은 정수 타입이 아니어서 건너뜁니다.` };
  }
  if (/^null(::[\w .]+)?$/i.test(s)) return {};
  for (const [re, out] of SAFE_EXPRESSIONS) {
    if (re.test(s)) return { expr: out ?? s.toLowerCase() };
  }
  // 따옴표 리터럴 (+선택적 캐스트): 'abc'::text, '{}'::jsonb, 'x'::mood
  if (/^'(?:[^']|'')*'(?:::[\w ."[\]]+)*$/.test(s)) return { expr: s };
  // 숫자 리터럴 (+선택적 괄호/캐스트)
  if (/^\(?-?\d+(?:\.\d+)?\)?(?:::[a-z ]+)?$/i.test(s)) {
    if (INTEGER_TYPES.has(mapped.base) || ["numeric", "real", "double precision", "money"].includes(mapped.base)) {
      return { expr: s };
    }
    if (TEXTISH_TYPES.has(mapped.base) || mapped.base === "enum") return { expr: sqlLiteral(s) };
    return { expr: s };
  }
  if (/^array\[\]::[\w ."]+\[\]$/i.test(s)) return { expr: s };

  // 함수 호출 등 표현식은 안전하지 않으므로 건너뜀
  if (/\(.*\)/.test(s) || s.includes("::")) {
    return { warning: `${where}: 기본값 표현식(${s})은 안전하게 복사할 수 없어 건너뜁니다.` };
  }
  // PostgREST는 문자열 리터럴의 따옴표/캐스트를 제거해 노출하는 경우가 있음
  if (TEXTISH_TYPES.has(mapped.base) || mapped.base === "enum") return { expr: sqlLiteral(s) };
  if (mapped.base === "uuid" && /^[0-9a-f-]{36}$/i.test(s)) return { expr: `${sqlLiteral(s)}::uuid` };
  if (mapped.base === "jsonb" || mapped.base === "json") {
    try {
      JSON.parse(s);
      return { expr: `${sqlLiteral(s)}::${mapped.base}` };
    } catch {
      /* fallthrough */
    }
  }
  return { warning: `${where}: 기본값(${s})을 해석할 수 없어 건너뜁니다.` };
}

// ---------------------------------------------------------------------------
// 위상 정렬
// ---------------------------------------------------------------------------

export interface TopoResult {
  order: string[];
  /** 순환 참조에 포함되어 순서를 보장할 수 없는 테이블 */
  cyclic: string[];
}

/** FK 의존성 기준으로 정렬 (참조되는 테이블 먼저). 자기 참조는 무시, 순환은 마지막에 원래 순서로 추가. */
export function topoSortTables(tables: TableDef[]): TopoResult {
  const names = tables.map((t) => t.name);
  const set = new Set(names);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const d = new Set<string>();
    for (const fk of t.foreignKeys) {
      if (fk.refTable !== t.name && set.has(fk.refTable)) d.add(fk.refTable);
    }
    deps.set(t.name, d);
  }
  const order: string[] = [];
  const done = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const n of names) {
      if (done.has(n)) continue;
      if ([...deps.get(n)!].every((d) => done.has(d))) {
        order.push(n);
        done.add(n);
        progressed = true;
      }
    }
  }
  const cyclic = names.filter((n) => !done.has(n));
  return { order: [...order, ...cyclic], cyclic };
}

// ---------------------------------------------------------------------------
// 배치 분할
// ---------------------------------------------------------------------------

export const MAX_BATCH_ROWS = 500;
export const MAX_BATCH_BYTES = 800 * 1024;

/** 행 배열을 행 수/JSON 바이트 크기 제한에 맞게 나눕니다. 제한보다 큰 단일 행은 단독 배치가 됩니다. */
export function chunkRows<T>(rows: T[], maxRows = MAX_BATCH_ROWS, maxBytes = MAX_BATCH_BYTES): T[][] {
  const enc = new TextEncoder();
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 2; // []
  for (const row of rows) {
    const size = enc.encode(JSON.stringify(row)).length + 1;
    if (cur.length > 0 && (cur.length >= maxRows || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(row);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// DDL / DML 생성
// ---------------------------------------------------------------------------

export interface CreateTableResult {
  sql: string;
  enumTypes: EnumTypeDef[];
  warnings: string[];
}

export function buildCreateTable(table: TableDef): CreateTableResult {
  const warnings: string[] = [];
  const enumTypes: EnumTypeDef[] = [];
  const lines: string[] = [];
  for (const col of table.columns) {
    const mapped = mapColumnType(col, table.name);
    warnings.push(...mapped.warnings);
    if (mapped.enumType) enumTypes.push(mapped.enumType);
    const def = renderDefault(col, mapped, table.name);
    if (def.warning) warnings.push(def.warning);
    let line = `  ${quoteIdent(col.name)} ${mapped.sql}`;
    if (def.identity) line += " generated by default as identity";
    if (col.notNull || col.isPk || def.identity) line += " not null";
    if (def.expr) line += ` default ${def.expr}`;
    lines.push(line);
  }
  if (table.primaryKey.length > 0) {
    lines.push(`  primary key (${table.primaryKey.map(quoteIdent).join(", ")})`);
  } else {
    warnings.push(`${table.name}: 기본 키가 없습니다.`);
  }
  const sql = `create table if not exists ${qualified(table.name)} (\n${lines.join(",\n")}\n);`;
  return { sql, enumTypes, warnings };
}

export function buildCreateEnum(e: EnumTypeDef): string {
  const values = e.values.map(sqlLiteral).join(", ");
  const body = `
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typname = ${sqlLiteral(e.name)} and n.nspname = ${sqlLiteral(SCHEMA)}
  ) then
    create type ${qualified(e.name)} as enum (${values});
  end if;
end
`;
  return `do ${dollarQuote(body)};`;
}

export function buildDropTable(table: string): string {
  return `drop table if exists ${qualified(table)} cascade;`;
}

export function fkConstraintName(table: string, column: string): string {
  return truncateIdent(`${table}_${column}_fkey`);
}

export function buildAddForeignKey(table: string, column: string, refTable: string, refColumn: string): string {
  const body = `
begin
  alter table ${qualified(table)}
    add constraint ${quoteIdent(fkConstraintName(table, column))}
    foreign key (${quoteIdent(column)}) references ${qualified(refTable)} (${quoteIdent(refColumn)});
exception when duplicate_object then
  null; -- 이미 존재
end
`;
  return `do ${dollarQuote(body)};`;
}

export function buildEnableRls(table: string): string {
  return `alter table ${qualified(table)} enable row level security;`;
}

export function buildTruncate(tables: string[]): string {
  return `truncate table ${tables.map((t) => qualified(t)).join(", ")} restart identity;`;
}

/** 시퀀스/identity 컬럼을 max(col)로 맞춥니다. 비어 있으면 1 (is_called=false). */
export function buildResetSequences(table: string): string {
  const reg = sqlLiteral(qualified(table));
  const body = `
declare
  r record;
  m bigint;
begin
  for r in
    select a.attname,
           coalesce(
             pg_get_serial_sequence(${reg}, a.attname),
             substring(pg_get_expr(d.adbin, d.adrelid) from 'nextval\\(''([^'']+)''')
           ) as seq
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = ${reg}::regclass and a.attnum > 0 and not a.attisdropped
  loop
    if r.seq is not null then
      execute format('select max(%I)::bigint from %s', r.attname, ${reg}) into m;
      if m is null then
        perform setval(r.seq::regclass, 1, false);
      else
        perform setval(r.seq::regclass, m, true);
      end if;
    end if;
  end loop;
end
`;
  return `do ${dollarQuote(body)};`;
}

export interface InsertOptions {
  replicaRole: boolean;
  onConflictDoNothing?: boolean;
  rng?: () => number;
}

/** json_populate_recordset 기반 INSERT 문 생성 */
export function buildInsertSql(table: TableDef, rows: unknown[], opts: InsertOptions): string {
  const cols = table.columns.map((c) => quoteIdent(c.name)).join(", ");
  const payload = JSON.stringify(rows);
  const tag = pickDollarTag(payload, opts.rng);
  const parts: string[] = [];
  if (opts.replicaRole) parts.push("set session_replication_role = replica;");
  parts.push(
    `insert into ${qualified(table.name)} (${cols}) overriding system value\n` +
      `select ${cols} from json_populate_recordset(null::${qualified(table.name)}, ${tag}${payload}${tag})` +
      (opts.onConflictDoNothing ? "\non conflict do nothing" : "") +
      ";",
  );
  if (opts.replicaRole) parts.push("reset session_replication_role;");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 전체 계획
// ---------------------------------------------------------------------------

export type Mode = "schema+data" | "data";
export type IfExists = "skip" | "drop";

export interface MigrationOptions {
  mode: Mode;
  ifExists: IfExists;
  truncate: boolean;
  replicaRole: boolean;
  enableRls: boolean;
  onConflictDoNothing: boolean;
}

export const DEFAULT_OPTIONS: MigrationOptions = {
  mode: "schema+data",
  ifExists: "skip",
  truncate: false,
  replicaRole: true,
  enableRls: true,
  onConflictDoNothing: false,
};

export interface PlanStep {
  kind: "enum" | "drop" | "create" | "fk" | "rls" | "truncate" | "sequence";
  table?: string;
  label: string;
  sql: string;
}

export interface MigrationPlan {
  order: string[];
  cyclic: string[];
  /** 데이터 이전 전에 실행 */
  pre: PlanStep[];
  /** 데이터 이전 후에 실행 */
  post: PlanStep[];
  warnings: string[];
}

export function buildMigrationPlan(all: TableDef[], selected: string[], options: MigrationOptions): MigrationPlan {
  const sel = new Set(selected);
  const tables = all.filter((t) => sel.has(t.name));
  const byName = new Map(tables.map((t) => [t.name, t]));
  const { order, cyclic } = topoSortTables(tables);
  const warnings: string[] = [];
  if (cyclic.length) warnings.push(`순환 FK 참조가 있어 순서를 보장할 수 없는 테이블: ${cyclic.join(", ")}`);

  const pre: PlanStep[] = [];
  const post: PlanStep[] = [];

  if (options.mode === "schema+data") {
    const enums = new Map<string, EnumTypeDef>();
    const creates: PlanStep[] = [];
    for (const name of order) {
      const t = byName.get(name)!;
      const r = buildCreateTable(t);
      warnings.push(...r.warnings);
      for (const e of r.enumTypes) {
        const prev = enums.get(e.name);
        if (prev && prev.values.join("\u0000") !== e.values.join("\u0000")) {
          warnings.push(`enum 타입 ${e.name}의 값 목록이 컬럼마다 다릅니다. 처음 발견된 정의를 사용합니다.`);
        } else if (!prev) enums.set(e.name, e);
      }
      creates.push({ kind: "create", table: name, label: `테이블 생성: ${name}`, sql: r.sql });
    }
    for (const e of enums.values()) {
      pre.push({ kind: "enum", label: `enum 타입: ${e.name}`, sql: buildCreateEnum(e) });
    }
    if (options.ifExists === "drop") {
      for (const name of [...order].reverse()) {
        pre.push({ kind: "drop", table: name, label: `테이블 삭제: ${name}`, sql: buildDropTable(name) });
      }
    }
    pre.push(...creates);
    for (const name of order) {
      const t = byName.get(name)!;
      for (const fk of t.foreignKeys) {
        if (!sel.has(fk.refTable)) {
          warnings.push(`${name}.${fk.column} → ${fk.refTable}.${fk.refColumn}: 참조 테이블이 선택되지 않아 FK를 건너뜁니다.`);
          continue;
        }
        pre.push({
          kind: "fk",
          table: name,
          label: `FK: ${name}.${fk.column} → ${fk.refTable}.${fk.refColumn}`,
          sql: buildAddForeignKey(name, fk.column, fk.refTable, fk.refColumn),
        });
      }
    }
    if (options.enableRls) {
      for (const name of order) {
        pre.push({ kind: "rls", table: name, label: `RLS 활성화: ${name}`, sql: buildEnableRls(name) });
      }
    }
  }

  const canTruncate = options.truncate && !(options.mode === "schema+data" && options.ifExists === "drop");
  if (canTruncate && order.length) {
    pre.push({ kind: "truncate", label: `TRUNCATE: ${order.length}개 테이블`, sql: buildTruncate(order) });
  }

  for (const name of order) {
    post.push({ kind: "sequence", table: name, label: `시퀀스 재설정: ${name}`, sql: buildResetSequences(name) });
  }

  return { order, cyclic, pre, post, warnings };
}

/** SQL 미리보기 텍스트 (데이터 본문은 생략) */
export function buildPreviewSql(plan: MigrationPlan, all: TableDef[], options: MigrationOptions, rowCounts: Record<string, number | null> = {}): string {
  const out: string[] = [];
  out.push("-- Supabase DB 복사 — 생성된 SQL 미리보기");
  out.push(`-- 모드: ${options.mode === "schema+data" ? "스키마+데이터" : "데이터만"}`);
  out.push(`-- 테이블 순서: ${plan.order.join(", ") || "(없음)"}`);
  if (plan.warnings.length) {
    out.push("--");
    out.push("-- 경고:");
    for (const w of plan.warnings) out.push(`--   * ${w.replace(/\n/g, " ")}`);
  }
  out.push("");
  for (const step of plan.pre) {
    out.push(`-- ${step.label}`);
    out.push(step.sql);
    out.push("");
  }
  const byName = new Map(all.map((t) => [t.name, t]));
  out.push("-- 데이터 삽입 (실행 시 배치마다 실제 JSON 데이터가 들어갑니다)");
  for (const name of plan.order) {
    const t = byName.get(name);
    if (!t) continue;
    const n = rowCounts[name];
    out.push(`-- ${name}: ${n == null ? "?" : n.toLocaleString()}행`);
    out.push(buildInsertSql(t, [], { replicaRole: options.replicaRole, onConflictDoNothing: options.onConflictDoNothing }).replace(/\$j_[a-z0-9]+\$\[\]\$j_[a-z0-9]+\$/, () => "$json$[ ...행 데이터... ]$json$"));
    out.push("");
  }
  for (const step of plan.post) {
    out.push(`-- ${step.label}`);
    out.push(step.sql);
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// PostgREST select 목록
// ---------------------------------------------------------------------------

const TEXT_CAST_TYPES = new Set(["bigint", "numeric", "money"]);

/**
 * PostgREST select 파라미터. JS number 정밀도 손실을 막기 위해 bigint/numeric은 ::text로 캐스트합니다.
 * (json_populate_recordset이 문자열을 원래 타입으로 다시 변환)
 */
export function buildSelectList(table: TableDef): string {
  const needsCast = table.columns.some((c) => {
    const b = normalizeBaseType(c.format);
    return b && TEXT_CAST_TYPES.has(b.replace(/\(.*\)$/, ""));
  });
  if (!needsCast) return "*";
  return table.columns
    .map((c) => {
      const simple = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name);
      const ref = simple ? c.name : `"${c.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      const b = normalizeBaseType(c.format);
      return b && TEXT_CAST_TYPES.has(b.replace(/\(.*\)$/, "")) ? `${ref}::text` : ref;
    })
    .join(",");
}
