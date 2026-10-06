/**
 * 마이그레이션 실행기 (브라우저). 원본에서 SourceReader로 행을 읽어 /api/target/query 로 대상에 씁니다.
 * (anon 모드는 브라우저가 직접, service_role 모드는 /api/source/* 서버 라우트를 통해 읽음)
 */
import {
  buildInsertSql,
  buildMigrationPlan,
  chunkRows,
  type MigrationOptions,
  type PlanStep,
  type TableDef,
} from "./ddl";
import { describeReader, type SourceReader } from "./source";

export type TableStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TableProgress {
  status: TableStatus;
  copied: number;
  total: number | null;
  error?: string;
}

export type LogLevel = "info" | "warn" | "error" | "success";

export interface RunCallbacks {
  log: (level: LogLevel, message: string) => void;
  progress: (table: string, p: Partial<TableProgress>) => void;
  shouldStop: () => boolean;
}

export interface RunInput {
  source: SourceReader;
  ref: string;
  tables: TableDef[];
  selected: string[];
  options: MigrationOptions;
  rowCounts: Record<string, number | null>;
  continueOnError: boolean;
}

export interface RunSummary {
  stopped: boolean;
  succeeded: string[];
  failed: string[];
  skipped: string[];
  totalRows: number;
  warnings: number;
  errors: number;
  elapsedMs: number;
}

export class StopError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 대상 프로젝트에 SQL 실행 (429/5xx는 재시도) */
export async function targetQuery(ref: string, query: string, log?: RunCallbacks["log"]): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch("/api/target/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, query }),
      });
    } catch (e) {
      if (attempt++ < 3) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`네트워크 오류: ${(e as Error).message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body.result;
    const retriable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (retriable && attempt < 5) {
      attempt++;
      const wait = Math.min(30000, 2000 * 2 ** (attempt - 1));
      log?.("warn", `대상 API 응답 ${res.status} — ${Math.round(wait / 1000)}초 후 재시도 (${attempt}/5)`);
      await sleep(wait);
      continue;
    }
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function runMigration(input: RunInput, cb: RunCallbacks): Promise<RunSummary> {
  const started = Date.now();
  const { options, ref } = input;
  const plan = buildMigrationPlan(input.tables, input.selected, options);
  const byName = new Map(input.tables.map((t) => [t.name, t]));
  const failed = new Set<string>();
  const succeeded: string[] = [];
  const skipped: string[] = [];
  let totalRows = 0;
  let warnings = 0;
  let errors = 0;
  let stopped = false;

  const warn = (m: string) => {
    warnings++;
    cb.log("warn", m);
  };
  const fail = (table: string | undefined, m: string) => {
    errors++;
    cb.log("error", m);
    if (table) {
      failed.add(table);
      cb.progress(table, { status: "failed", error: m });
    }
    if (!input.continueOnError) throw new StopError("오류로 인해 중단했습니다 (오류 시 계속 옵션 꺼짐).");
  };
  const checkStop = () => {
    if (cb.shouldStop()) throw new StopError("사용자가 중지했습니다.");
  };

  for (const name of plan.order) {
    cb.progress(name, { status: "pending", copied: 0, total: input.rowCounts[name] ?? null, error: undefined });
  }
  for (const w of plan.warnings) warn(w);

  const runStep = async (step: PlanStep) => {
    checkStop();
    if (step.table && failed.has(step.table) && step.kind !== "drop") {
      cb.log("warn", `건너뜀 (테이블 실패): ${step.label}`);
      return;
    }
    cb.log("info", step.label);
    try {
      await targetQuery(ref, step.sql, cb.log);
    } catch (e) {
      const msg = `${step.label} 실패: ${(e as Error).message}`;
      if (step.kind === "fk" || step.kind === "rls" || step.kind === "sequence") {
        // 부가 작업 실패는 테이블 실패로 보지 않음
        warn(msg);
        if (!input.continueOnError) throw new StopError(msg);
      } else if (step.kind === "truncate" || step.kind === "enum") {
        fail(undefined, msg);
      } else {
        fail(step.table, msg);
      }
    }
  };

  try {
    cb.log("info", `시작: ${plan.order.length}개 테이블 → 프로젝트 ${ref}`);
    cb.log(input.source.mode === "anon" ? "info" : "warn", `원본 읽기 모드: ${describeReader(input.source)}`);
    if (input.source.mode === "anon") cb.log("info", "anon 모드: RLS 정책이 허용하는 행만 복사됩니다.");
    else cb.log("warn", "service_role 모드: RLS를 우회하여 모든 행을 서버에서 읽습니다.");
    for (const step of plan.pre) await runStep(step);

    for (const name of plan.order) {
      checkStop();
      const table = byName.get(name)!;
      if (failed.has(name)) {
        cb.log("warn", `${name}: 이전 단계 실패로 데이터 복사를 건너뜁니다.`);
        continue;
      }
      cb.progress(name, { status: "running" });
      cb.log("info", `${name}: 데이터 복사 시작`);
      if (table.primaryKey.length === 0) {
        warn(`${name}: 기본 키가 없어 페이지 순서가 보장되지 않습니다 (복사 중 원본이 변경되면 누락/중복 가능).`);
      }
      let copied = 0;
      let offset = 0;
      try {
        for (;;) {
          checkStop();
          const rows = await input.source.fetchPage(table, offset);
          if (rows.length === 0) break;
          offset += rows.length;
          for (const batch of chunkRows(rows)) {
            checkStop();
            const sql = buildInsertSql(table, batch, {
              replicaRole: options.replicaRole,
              onConflictDoNothing: options.onConflictDoNothing,
            });
            await targetQuery(ref, sql, cb.log);
            copied += batch.length;
            totalRows += batch.length;
            cb.progress(name, { copied });
          }
        }
        cb.progress(name, { status: "done", copied });
        succeeded.push(name);
        cb.log("success", `${name}: ${copied.toLocaleString()}행 완료`);
      } catch (e) {
        if (e instanceof StopError) {
          failed.add(name);
          cb.progress(name, { status: "failed", error: "중지됨", copied });
          throw e;
        }
        cb.progress(name, { copied });
        fail(name, `${name}: 데이터 복사 실패 (${copied.toLocaleString()}행 복사 후): ${(e as Error).message}`);
      }
    }

    for (const step of plan.post) await runStep(step);
  } catch (e) {
    if (e instanceof StopError) {
      stopped = true;
      cb.log("warn", e.message);
    } else {
      errors++;
      cb.log("error", `예상치 못한 오류: ${(e as Error).message}`);
      stopped = true;
    }
  }

  for (const name of plan.order) {
    if (!succeeded.includes(name) && !failed.has(name)) {
      skipped.push(name);
      cb.progress(name, { status: "skipped" });
    }
  }

  const summary: RunSummary = {
    stopped,
    succeeded,
    failed: [...failed],
    skipped,
    totalRows,
    warnings,
    errors,
    elapsedMs: Date.now() - started,
  };
  cb.log(
    failed.size || stopped ? "warn" : "success",
    `종료: 성공 ${succeeded.length}, 실패 ${failed.size}, 건너뜀 ${skipped.length}, 총 ${totalRows.toLocaleString()}행, ${(summary.elapsedMs / 1000).toFixed(1)}초`,
  );
  return summary;
}
