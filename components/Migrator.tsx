"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_OPTIONS,
  buildMigrationPlan,
  buildPreviewSql,
  mapColumnType,
  renderDefault,
  type MigrationOptions,
  type TableDef,
} from "@/lib/ddl";
import {
  SOURCE_MODE_LABEL,
  createAnonReader,
  createServerReader,
  fetchSourceStatus,
  forgetServiceKey,
  normalizeUrl,
  saveServiceKey,
  type SourceMode,
  type SourceReader,
  type SourceStatus,
} from "@/lib/source";
import { projectRefFromUrl, sameSourceUrl } from "@/lib/source-core";
import { runMigration, targetQuery, type LogLevel, type RunSummary, type TableProgress } from "@/lib/runner";
import { Alert, Badge, Button, Card, ProgressBar, cx, inputClass } from "./ui";

interface Project {
  ref: string;
  name: string;
  region: string;
  status: string;
}

interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
}

/**
 * 단계 순서: 계정 로그인을 먼저 둡니다. 대상 쓰기에 어차피 필요하고,
 * service_role(env) 모드는 로그인한 계정이 원본 프로젝트에 접근할 수 있는지 확인한 뒤에만 쓸 수 있기 때문입니다.
 * (anon 모드는 로그인 없이도 원본 단계를 진행할 수 있습니다.)
 */
const STEPS = ["계정 로그인", "원본(Source)", "대상(Target)", "테이블 선택", "실행"] as const;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

export default function Migrator({ defaultUrl, defaultAnonKey }: { defaultUrl: string; defaultAnonKey: string }) {
  const [step, setStep] = useState(1);

  // ---- Source
  const [srcMode, setSrcMode] = useState<SourceMode>("anon");
  const [srcUrl, setSrcUrl] = useState(defaultUrl);
  const [srcKey, setSrcKey] = useState(defaultAnonKey);
  const [svcKey, setSvcKey] = useState("");
  const [srcStatus, setSrcStatus] = useState<SourceStatus | null>(null);
  const [source, setSource] = useState<SourceReader | null>(null);
  const [srcLoading, setSrcLoading] = useState(false);
  const [srcError, setSrcError] = useState<string | null>(null);
  const [srcNotice, setSrcNotice] = useState<string | null>(null);
  const [tables, setTables] = useState<TableDef[]>([]);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [rowCounts, setRowCounts] = useState<Record<string, number | null>>({});
  const [countErrors, setCountErrors] = useState<Record<string, string>>({});

  // ---- Target
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [ref, setRef] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  // ---- Selection & options
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [options, setOptions] = useState<MigrationOptions>(DEFAULT_OPTIONS);
  const [dropConfirmed, setDropConfirmed] = useState(false);
  const [continueOnError, setContinueOnError] = useState(true);

  // ---- Run
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, TableProgress>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const stopRef = useRef(false);
  const [stopRequested, setStopRequested] = useState(false);
  const logId = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);
  const connectSeq = useRef(0);

  // ======================================================================
  // Source
  // ======================================================================
  const resetSource = useCallback(() => {
    connectSeq.current++;
    setSource(null);
    setTables([]);
    setRowCounts({});
    setCountErrors({});
    setParseWarnings([]);
  }, []);

  /** 리더로 스키마/행 수를 불러옵니다 (anon: 브라우저 직접, service_role: 서버 경유). */
  const connectReader = useCallback(
    async (reader: SourceReader) => {
      resetSource();
      const seq = connectSeq.current;
      setSrcLoading(true);
      setSrcError(null);
      try {
        const { tables: parsed, warnings } = await reader.introspect();
        if (seq !== connectSeq.current) return;
        setTables(parsed);
        setParseWarnings(warnings);
        setSource(reader);
        setSelected(new Set(parsed.filter((t) => !t.likelyView).map((t) => t.name)));
        // 행 수 조회 (동시 4개)
        await mapLimit(parsed, 4, async (t) => {
          if (seq !== connectSeq.current) return;
          try {
            const n = await reader.count(t.name);
            if (seq === connectSeq.current) setRowCounts((prev) => ({ ...prev, [t.name]: n }));
          } catch (e) {
            if (seq !== connectSeq.current) return;
            setRowCounts((prev) => ({ ...prev, [t.name]: null }));
            setCountErrors((prev) => ({ ...prev, [t.name]: (e as Error).message }));
          }
        });
      } catch (e) {
        if (seq === connectSeq.current) setSrcError((e as Error).message);
      } finally {
        if (seq === connectSeq.current) setSrcLoading(false);
      }
    },
    [resetSource],
  );

  const loadSourceStatus = useCallback(async () => {
    try {
      setSrcStatus(await fetchSourceStatus());
    } catch (e) {
      setSrcStatus(null);
      setSrcError(`원본 모드 상태를 불러오지 못했습니다: ${(e as Error).message}`);
    }
  }, []);

  // ======================================================================
  // Target
  // ======================================================================
  const loadProjects = useCallback(async (): Promise<boolean> => {
    setTargetError(null);
    try {
      const res = await fetch("/api/target/projects", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setLoggedIn(false);
        setProjects([]);
        if (body.error && body.error !== "로그인이 필요합니다.") setTargetError(body.error);
        return false;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setLoggedIn(true);
      setProjects(body.projects ?? []);
      return true;
    } catch (e) {
      setTargetError((e as Error).message);
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 초기 로드: 세션 쿠키/원본 모드 상태 확인, env anon 값으로 원본 연결
    const init = async () => {
      await Promise.resolve();
      if (cancelled) return;
      if (defaultUrl && defaultAnonKey) {
        try {
          void connectReader(createAnonReader(defaultUrl, defaultAnonKey));
        } catch (e) {
          setSrcError((e as Error).message);
        }
      }
      void loadSourceStatus();
      const ok = await loadProjects();
      if (!cancelled && ok) setStep((s) => (s === 1 ? 2 : s));
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, [defaultUrl, defaultAnonKey, connectReader, loadProjects, loadSourceStatus]);

  const login = async () => {
    setLoginBusy(true);
    setTargetError(null);
    try {
      const res = await fetch("/api/target/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setToken("");
      await loadProjects();
      await loadSourceStatus();
    } catch (e) {
      setTargetError((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/target/logout", { method: "POST" }).catch(() => undefined);
    setLoggedIn(false);
    setProjects([]);
    setRef("");
    setTestResult(null);
    // env service_role 모드는 로그인이 필요하므로 연결을 해제
    if (source?.mode === "service-env") resetSource();
    await loadSourceStatus();
  };

  const testConnection = async () => {
    setTestResult(null);
    setTargetError(null);
    try {
      const r = await targetQuery(ref, "select current_database() as db, version() as version;");
      const row = Array.isArray(r) ? (r[0] as Record<string, string>) : null;
      setTestResult(row ? `연결 성공: ${row.db} — ${String(row.version).split(" on ")[0]}` : "연결 성공");
    } catch (e) {
      setTargetError((e as Error).message);
    }
  };

  // ---- 원본 모드별 사용 가능 여부
  const envInfo = srcStatus?.env;
  const envUrlMatches = !!envInfo?.url && sameSourceUrl(srcUrl, envInfo.url);
  const envBlocker: string | null = !srcStatus
    ? "서버 상태 확인 중…"
    : !envInfo?.available
      ? (envInfo?.reason ?? "사용할 수 없습니다.")
      : !envUrlMatches
        ? `원본 URL을 바꿔서 사용할 수 없습니다. env 키는 환경 변수 URL(${envInfo.url})에만 사용됩니다.`
        : srcStatus.envAccess.state === "login-required" || loggedIn !== true
          ? "먼저 1단계에서 Supabase 계정으로 로그인하세요 (원본 프로젝트 접근 권한 확인)."
          : srcStatus.envAccess.state === "denied" || srcStatus.envAccess.state === "error"
            ? (srcStatus.envAccess.message ?? "원본 프로젝트 접근 권한을 확인할 수 없습니다.")
            : null;
  const storedKey = srcStatus?.cookie;
  const storedKeyMatches = !!storedKey?.present && sameSourceUrl(srcUrl, storedKey.url);

  const connectSource = async () => {
    setSrcError(null);
    setSrcNotice(null);
    const url = normalizeUrl(srcUrl);
    try {
      if (srcMode === "anon") {
        if (!url || !srcKey.trim()) {
          setSrcError("URL과 anon 키를 입력하세요.");
          return;
        }
        await connectReader(createAnonReader(url, srcKey));
      } else if (srcMode === "service-env") {
        if (envBlocker) {
          setSrcError(envBlocker);
          return;
        }
        await connectReader(createServerReader("service-env", url));
      } else {
        if (svcKey.trim()) {
          setSrcLoading(true);
          try {
            const saved = await saveServiceKey(url, svcKey.trim());
            setSvcKey("");
            setSrcNotice(`키를 서버 쿠키에 저장했습니다 (${saved.url} 전용, 키 종류: ${saved.keyKind}).`);
          } finally {
            setSrcLoading(false);
          }
          await loadSourceStatus();
        } else if (!storedKeyMatches) {
          setSrcError(storedKey?.present ? `저장된 키는 ${storedKey.url} 에 묶여 있습니다. 이 URL용 service_role 키를 입력하세요.` : "service_role 키를 입력하세요.");
          return;
        }
        await connectReader(createServerReader("service-cookie", url));
      }
    } catch (e) {
      setSrcError((e as Error).message);
    }
  };

  const forgetKey = async () => {
    await forgetServiceKey().catch(() => undefined);
    if (source?.mode === "service-cookie") resetSource();
    setSrcNotice("저장된 service_role 키를 삭제했습니다.");
    await loadSourceStatus();
  };

  // ======================================================================
  // Plan
  // ======================================================================
  const selectedList = useMemo(() => tables.filter((t) => selected.has(t.name)).map((t) => t.name), [tables, selected]);
  const plan = useMemo(() => buildMigrationPlan(tables, selectedList, options), [tables, selectedList, options]);
  const previewSql = useMemo(
    () => (showPreview ? buildPreviewSql(plan, tables, options, rowCounts) : ""),
    [showPreview, plan, tables, options, rowCounts],
  );

  const srcRef = source ? projectRefFromUrl(source.url) : null;
  const sameProject = !!srcRef && srcRef === ref;
  const needsDropConfirm = options.mode === "schema+data" && options.ifExists === "drop";
  const canRun =
    !!source && loggedIn === true && !!ref && selectedList.length > 0 && !running && (!needsDropConfirm || dropConfirmed);

  const stepEnabled = (n: number) => {
    if (n === 1 || n === 2) return true; // anon 모드는 로그인 없이 원본 단계 진행 가능
    if (n === 3) return !!source && loggedIn === true;
    if (n === 4) return !!source && loggedIn === true && !!ref;
    return !!source && loggedIn === true && !!ref && selectedList.length > 0;
  };

  // ======================================================================
  // Run
  // ======================================================================
  const addLog = useCallback((level: LogLevel, message: string) => {
    const entry: LogEntry = { id: ++logId.current, time: new Date().toLocaleTimeString("ko-KR"), level, message };
    setLogs((prev) => (prev.length > 2000 ? [...prev.slice(-1500), entry] : [...prev, entry]));
  }, []);

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs]);

  const start = async () => {
    if (!source || !canRun) return;
    stopRef.current = false;
    setStopRequested(false);
    setRunning(true);
    setSummary(null);
    setLogs([]);
    setProgress({});
    try {
      const result = await runMigration(
        { source, ref, tables, selected: selectedList, options, rowCounts, continueOnError },
        {
          log: addLog,
          progress: (table, p) =>
            setProgress((prev) => ({
              ...prev,
              [table]: { ...(prev[table] ?? { status: "pending", copied: 0, total: null }), ...p },
            })),
          shouldStop: () => stopRef.current,
        },
      );
      setSummary(result);
    } finally {
      setRunning(false);
    }
  };

  const stop = () => {
    stopRef.current = true;
    setStopRequested(true);
    addLog("warn", "중지 요청됨 — 현재 배치가 끝나면 중지합니다.");
  };

  const overall = useMemo(() => {
    const names = plan.order;
    if (!names.length) return 0;
    const totalKnown = names.reduce((s, n) => s + (rowCounts[n] ?? 0), 0);
    const copiedSum = names.reduce((s, n) => s + (progress[n]?.copied ?? 0), 0);
    const finished = names.filter((n) => ["done", "failed", "skipped"].includes(progress[n]?.status ?? "")).length;
    if (totalKnown > 0) return Math.min(1, copiedSum / totalKnown);
    return finished / names.length;
  }, [plan.order, rowCounts, progress]);

  const copyPreview = async () => {
    try {
      await navigator.clipboard.writeText(buildPreviewSql(plan, tables, options, rowCounts));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const filteredTables = tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  const setOpt = <K extends keyof MigrationOptions>(k: K, v: MigrationOptions[K]) => setOptions((o) => ({ ...o, [k]: v }));

  // ======================================================================
  // Render
  // ======================================================================
  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Supabase DB 복사</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          원본 프로젝트의 <code>public</code> 스키마 테이블과 데이터를 대상 프로젝트로 복사합니다.
        </p>
      </header>

      <Limitations />

      {source && (
        <div
          className={cx(
            "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm",
            source.mode === "anon"
              ? "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              : "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200",
          )}
        >
          <span className="font-medium">원본 읽기:</span>
          <SourceModeBadge mode={source.mode} />
          <code className="text-xs">{source.url}</code>
          {source.mode !== "anon" && <span className="text-xs">RLS 우회 — 모든 행을 서버에서 읽습니다</span>}
        </div>
      )}

      {/* Stepper */}
      <nav className="flex flex-wrap gap-2">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const enabled = stepEnabled(n) && !running;
          return (
            <button
              key={label}
              type="button"
              disabled={!enabled}
              onClick={() => setStep(n)}
              className={cx(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-40",
                step === n
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-slate-300 bg-white hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800",
              )}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/10 text-xs font-bold">{n}</span>
              {label}
            </button>
          );
        })}
      </nav>

      {/* ---------------- Step 1: Login ---------------- */}
      {step === 1 && (
        <Card
          title="1. Supabase 계정 로그인"
          right={loggedIn ? <Badge tone="green">로그인됨</Badge> : loggedIn === null ? <Badge tone="blue">확인 중…</Badge> : <Badge>로그아웃</Badge>}
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Supabase Personal Access Token으로 로그인합니다. 대상 프로젝트에 쓰기 위해 필요하며, 원본을{" "}
              <b>service_role (env)</b> 모드로 읽을 때는 이 계정이 원본 프로젝트에 접근할 수 있는지 확인하는 데에도 쓰입니다.{" "}
              <a className="text-emerald-700 underline dark:text-emerald-400" href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">
                토큰 발급 페이지 ↗
              </a>
              <br />
              토큰은 서버의 httpOnly 쿠키에만 저장되며 브라우저 스크립트에서 읽을 수 없습니다.
            </p>
            {loggedIn === false && (
              <>
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void login();
                  }}
                >
                  <input
                    className={cx(inputClass, "flex-1 min-w-60")}
                    type="password"
                    placeholder="sbp_..."
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoComplete="off"
                  />
                  <Button type="submit" disabled={loginBusy || !token.trim()}>
                    {loginBusy ? "확인 중…" : "로그인"}
                  </Button>
                </form>
                {token && !token.trim().startsWith("sbp_") && <Alert tone="amber">일반적으로 Personal Access Token은 sbp_ 로 시작합니다.</Alert>}
              </>
            )}
            {loggedIn && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>접근 가능한 프로젝트 {projects.length}개</span>
                <Button variant="ghost" onClick={() => void logout()}>
                  로그아웃
                </Button>
              </div>
            )}
            {targetError && <Alert>{targetError}</Alert>}
            <div className="flex justify-end">
              <Button onClick={() => setStep(2)}>{loggedIn ? "다음 →" : "로그인 없이 원본 설정 (anon 모드만) →"}</Button>
            </div>
          </div>
        </Card>
      )}

      {/* ---------------- Step 2: Source ---------------- */}
      {step === 2 && (
        <Card
          title="2. 원본(Source) 프로젝트"
          right={
            source ? (
              <Badge tone="green">연결됨 · 테이블 {tables.length}개</Badge>
            ) : srcLoading ? (
              <Badge tone="blue">연결 중…</Badge>
            ) : (
              <Badge>미연결</Badge>
            )
          }
        >
          <div className="space-y-3">
            <fieldset className="space-y-1.5 text-sm">
              <legend className="mb-1 font-medium">읽기 방식</legend>
              <ModeOption
                checked={srcMode === "anon"}
                onChange={() => setSrcMode("anon")}
                label={SOURCE_MODE_LABEL.anon}
                hint="브라우저가 anon 키로 직접 읽습니다. RLS 정책이 허용하는 행만 읽힙니다."
              />
              <ModeOption
                checked={srcMode === "service-env"}
                onChange={() => setSrcMode("service-env")}
                label={SOURCE_MODE_LABEL["service-env"]}
                hint={
                  envBlocker && srcMode !== "service-env"
                    ? `사용 불가: ${envBlocker}`
                    : "서버 환경 변수 SUPABASE_SERVICE_ROLE_KEY로 서버에서 읽습니다. 키는 브라우저로 전달되지 않습니다."
                }
                disabled={!envInfo?.available}
              />
              <ModeOption
                checked={srcMode === "service-cookie"}
                onChange={() => setSrcMode("service-cookie")}
                label={SOURCE_MODE_LABEL["service-cookie"]}
                hint="키를 한 번 서버로 보내 httpOnly 쿠키(8시간)에 원본 URL과 함께 저장하고, 이후 서버에서 읽습니다."
              />
            </fieldset>

            {srcMode !== "anon" && <ServiceRoleWarning />}

            <label className="block text-sm">
              <span className="mb-1 block font-medium">Project URL</span>
              <input className={inputClass} value={srcUrl} onChange={(e) => setSrcUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
            </label>

            {srcMode === "anon" && (
              <>
                <p className="text-xs text-slate-500">
                  기본값은 환경 변수 <code>NEXT_PUBLIC_SUPABASE_URL</code> / <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> 입니다.
                </p>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">anon 키</span>
                  <input className={inputClass} type="password" value={srcKey} onChange={(e) => setSrcKey(e.target.value)} placeholder="eyJ..." autoComplete="off" />
                </label>
              </>
            )}

            {srcMode === "service-env" && (
              <>
                {envBlocker ? (
                  <Alert tone="amber">
                    <div>{envBlocker}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {envInfo?.available && !envUrlMatches && (
                        <Button variant="secondary" onClick={() => setSrcUrl(envInfo.url!)}>
                          환경 변수 URL 사용
                        </Button>
                      )}
                      {envInfo?.available && envUrlMatches && loggedIn !== true && (
                        <Button variant="secondary" onClick={() => setStep(1)}>
                          ← 1단계에서 로그인
                        </Button>
                      )}
                    </div>
                  </Alert>
                ) : (
                  <Alert tone="blue">
                    env 키 사용 가능: <code>{envInfo?.url}</code>
                    {envInfo?.gate === "project-access" ? ` · 로그인한 계정이 프로젝트 ${envInfo.ref}에 접근 가능함을 확인했습니다.` : " · ALLOW_UNVERIFIED_SERVICE_ROLE=true (접근 확인 없음)"}
                  </Alert>
                )}
                {envInfo?.keyKind && envInfo.keyKind !== "service_role" && envInfo.keyKind !== "secret" && (
                  <Alert tone="amber">환경 변수 키가 service_role 키가 아닌 것 같습니다 (종류: {envInfo.keyKind}). RLS가 적용될 수 있습니다.</Alert>
                )}
              </>
            )}

            {srcMode === "service-cookie" && (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">service_role 키</span>
                  <input
                    className={inputClass}
                    type="password"
                    value={svcKey}
                    onChange={(e) => setSvcKey(e.target.value)}
                    placeholder={storedKeyMatches ? "저장된 키 사용 (새 키를 입력하면 교체)" : "eyJ... 또는 sb_secret_..."}
                    autoComplete="off"
                  />
                </label>
                {storedKey?.present && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>
                      저장된 키: <code>{storedKey.url}</code> 전용 {storedKey.keyKind && `(${storedKey.keyKind})`}
                    </span>
                    {!storedKeyMatches && <Badge tone="amber">현재 URL과 다름 — 사용 불가</Badge>}
                    <Button variant="ghost" onClick={() => void forgetKey()}>
                      저장된 키 삭제
                    </Button>
                  </div>
                )}
              </>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void connectSource()} disabled={srcLoading || (srcMode === "service-env" && !!envBlocker)}>
                {srcLoading ? "불러오는 중…" : "연결 및 스키마 불러오기"}
              </Button>
              {(srcUrl !== defaultUrl || srcKey !== defaultAnonKey) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSrcUrl(defaultUrl);
                    setSrcKey(defaultAnonKey);
                  }}
                >
                  환경 변수 값으로 되돌리기
                </Button>
              )}
            </div>
            {!defaultUrl && !source && srcMode === "anon" && <Alert tone="amber">환경 변수가 설정되지 않았습니다. URL과 anon 키를 직접 입력하세요.</Alert>}
            {srcNotice && <Alert tone="blue">{srcNotice}</Alert>}
            {srcError && <Alert>{srcError}</Alert>}
            {source && (
              <Alert tone="green">
                {source.url} 에 <b>{SOURCE_MODE_LABEL[source.mode]}</b> 방식으로 연결되었습니다. 테이블/뷰 {tables.length}개를 찾았습니다
                {tables.some((t) => t.likelyView) && ` (뷰로 추정: ${tables.filter((t) => t.likelyView).length}개)`}.
                {source.mode !== srcMode && " (선택한 읽기 방식과 다릅니다 — 바꾸려면 다시 연결하세요.)"}
              </Alert>
            )}
            {parseWarnings.length > 0 && (
              <Alert tone="amber">
                {parseWarnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </Alert>
            )}
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(1)}>
                ← 이전
              </Button>
              <Button onClick={() => setStep(3)} disabled={!stepEnabled(3)} title={loggedIn !== true ? "1단계에서 로그인하세요" : undefined}>
                다음 →
              </Button>
            </div>
            {source && loggedIn !== true && <p className="text-right text-xs text-slate-500">다음 단계(대상 선택)로 가려면 1단계에서 로그인하세요.</p>}
          </div>
        </Card>
      )}

      {/* ---------------- Step 3: Target ---------------- */}
      {step === 3 && (
        <Card title="3. 대상(Target) 프로젝트" right={loggedIn ? <Badge tone="green">로그인됨</Badge> : <Badge>로그아웃</Badge>}>
          <div className="space-y-3">
            {loggedIn !== true && <Alert tone="amber">1단계에서 Supabase 계정으로 로그인하세요.</Alert>}
            {loggedIn && (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block flex-1 min-w-60 text-sm">
                    <span className="mb-1 block font-medium">대상 프로젝트</span>
                    <select
                      className={inputClass}
                      value={ref}
                      onChange={(e) => {
                        setRef(e.target.value);
                        setTestResult(null);
                      }}
                    >
                      <option value="">— 프로젝트 선택 —</option>
                      {projects.map((p) => (
                        <option key={p.ref} value={p.ref}>
                          {p.name} ({p.ref}) · {p.region} · {p.status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button variant="secondary" onClick={() => void loadProjects()}>
                    새로고침
                  </Button>
                  <Button variant="secondary" onClick={() => void testConnection()} disabled={!ref}>
                    연결 테스트
                  </Button>
                </div>
                {projects.length === 0 && <Alert tone="amber">이 계정에서 접근 가능한 프로젝트가 없습니다.</Alert>}
                {ref && projects.find((p) => p.ref === ref)?.status && projects.find((p) => p.ref === ref)!.status !== "ACTIVE_HEALTHY" && (
                  <Alert tone="amber">선택한 프로젝트 상태가 {projects.find((p) => p.ref === ref)!.status} 입니다. 쿼리가 실패할 수 있습니다.</Alert>
                )}
                {sameProject && <Alert>대상 프로젝트가 원본 프로젝트와 같습니다! 데이터가 손상될 수 있으니 다른 프로젝트를 선택하세요.</Alert>}
                {testResult && <Alert tone="green">{testResult}</Alert>}
              </>
            )}
            {targetError && <Alert>{targetError}</Alert>}
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(2)}>
                ← 이전
              </Button>
              <Button onClick={() => setStep(4)} disabled={!stepEnabled(4)}>
                다음 →
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* ---------------- Step 4: Tables ---------------- */}
      {step === 4 && (
        <>
          <Card
            title="4. 테이블 선택"
            right={
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-500">
                  {selectedList.length}/{tables.length} 선택
                </span>
                <Button variant="secondary" onClick={() => setSelected(new Set(tables.filter((t) => !t.likelyView).map((t) => t.name)))}>
                  테이블 전체
                </Button>
                <Button variant="secondary" onClick={() => setSelected(new Set(tables.map((t) => t.name)))}>
                  모두
                </Button>
                <Button variant="secondary" onClick={() => setSelected(new Set())}>
                  해제
                </Button>
              </div>
            }
          >
            <input className={cx(inputClass, "mb-3")} placeholder="테이블 검색…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {filteredTables.map((t) => (
                <div key={t.name}>
                  <div className="flex items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-emerald-600"
                      checked={selected.has(t.name)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(t.name);
                          else next.delete(t.name);
                          return next;
                        })
                      }
                    />
                    <button type="button" className="flex flex-1 items-center gap-2 text-left" onClick={() => setExpanded(expanded === t.name ? null : t.name)}>
                      <span className="font-mono text-sm">{t.name}</span>
                      {t.likelyView && <Badge tone="amber">뷰?</Badge>}
                      {t.primaryKey.length === 0 && <Badge tone="amber">PK 없음</Badge>}
                      {t.foreignKeys.length > 0 && <Badge tone="blue">FK {t.foreignKeys.length}</Badge>}
                      <span className="text-xs text-slate-500">컬럼 {t.columns.length}</span>
                      <span className="ml-auto text-xs text-slate-500">{expanded === t.name ? "▲" : "▼"}</span>
                    </button>
                    <span className="w-28 text-right text-sm tabular-nums" title={countErrors[t.name]}>
                      {t.name in rowCounts ? (rowCounts[t.name] == null ? <span className="text-red-600">오류</span> : `${rowCounts[t.name]!.toLocaleString()}행`) : "…"}
                    </span>
                  </div>
                  {expanded === t.name && <ColumnPreview table={t} countError={countErrors[t.name]} />}
                </div>
              ))}
              {filteredTables.length === 0 && <div className="p-4 text-sm text-slate-500">테이블이 없습니다.</div>}
            </div>
          </Card>

          <Card title="옵션">
            <div className="grid gap-4 md:grid-cols-2">
              <fieldset className="space-y-1 text-sm">
                <legend className="mb-1 font-medium">모드</legend>
                <Radio checked={options.mode === "schema+data"} onChange={() => setOpt("mode", "schema+data")} label="스키마+데이터" />
                <Radio checked={options.mode === "data"} onChange={() => setOpt("mode", "data")} label="데이터만 (대상에 테이블이 이미 있어야 함)" />
              </fieldset>
              {options.mode === "schema+data" && (
                <fieldset className="space-y-1 text-sm">
                  <legend className="mb-1 font-medium">대상에 테이블이 이미 있으면</legend>
                  <Radio checked={options.ifExists === "skip"} onChange={() => setOpt("ifExists", "skip")} label="건너뛰기 (CREATE TABLE IF NOT EXISTS)" />
                  <Radio checked={options.ifExists === "drop"} onChange={() => setOpt("ifExists", "drop")} label="삭제 후 재생성 (DROP TABLE ... CASCADE)" />
                </fieldset>
              )}
              <div className="space-y-1 text-sm md:col-span-2">
                {!(options.mode === "schema+data" && options.ifExists === "drop") && (
                  <Check
                    checked={options.truncate}
                    onChange={(v) => setOpt("truncate", v)}
                    label="기존 데이터 비우기 (TRUNCATE ... RESTART IDENTITY) — 선택한 테이블 대상"
                  />
                )}
                <Check
                  checked={options.replicaRole}
                  onChange={(v) => setOpt("replicaRole", v)}
                  label="FK/트리거 비활성화 (session_replication_role = replica)"
                />
                {options.mode === "schema+data" && (
                  <Check checked={options.enableRls} onChange={(v) => setOpt("enableRls", v)} label="대상 테이블 RLS 활성화 (정책은 복사되지 않음)" />
                )}
                <Check
                  checked={options.onConflictDoNothing}
                  onChange={(v) => setOpt("onConflictDoNothing", v)}
                  label="중복 행 무시 (INSERT ... ON CONFLICT DO NOTHING)"
                />
                <Check checked={continueOnError} onChange={setContinueOnError} label="오류가 나도 다음 테이블 계속 진행" />
              </div>
            </div>
            {needsDropConfirm && (
              <div className="mt-4">
                <Alert>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-red-600" checked={dropConfirmed} onChange={(e) => setDropConfirmed(e.target.checked)} />
                    <span>
                      대상 프로젝트 <b>{ref}</b>의 선택된 테이블 {selectedList.length}개와 이를 참조하는 객체(FK, 뷰 등)가 <b>CASCADE로 삭제</b>되며
                      되돌릴 수 없음을 이해했습니다.
                    </span>
                  </label>
                </Alert>
              </div>
            )}
            {options.truncate && !needsDropConfirm && (
              <div className="mt-4">
                <Alert tone="amber">TRUNCATE는 대상 테이블의 기존 데이터를 모두 삭제합니다. 선택하지 않은 테이블이 이 테이블들을 FK로 참조하면 실패합니다.</Alert>
              </div>
            )}
            {options.enableRls && options.mode === "schema+data" && (
              <p className="mt-3 text-xs text-slate-500">
                RLS를 켜면 정책이 없으므로 대상 프로젝트에서 anon/authenticated 역할은 데이터를 읽을 수 없습니다. 필요한 정책을 직접 추가하세요.
              </p>
            )}
            {plan.warnings.length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-amber-700 dark:text-amber-400">경고 {plan.warnings.length}개 보기</summary>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-800 dark:text-amber-300">
                  {plan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="mt-4 flex justify-between">
              <Button variant="secondary" onClick={() => setStep(3)}>
                ← 이전
              </Button>
              <Button onClick={() => setStep(5)} disabled={!stepEnabled(5)}>
                다음 →
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* ---------------- Step 5: Run ---------------- */}
      {step === 5 && (
        <>
          <Card
            title="5. 실행"
            right={
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setShowPreview((v) => !v)}>
                  {showPreview ? "SQL 미리보기 닫기" : "SQL 미리보기"}
                </Button>
                <Button variant="secondary" onClick={() => void copyPreview()}>
                  {copied ? "복사됨 ✓" : "SQL 복사"}
                </Button>
              </div>
            }
          >
            <div className="space-y-3 text-sm">
              <div className="grid gap-1 sm:grid-cols-2">
                <div>
                  원본: <code>{source?.url}</code> {source && <SourceModeBadge mode={source.mode} />}
                </div>
                <div>
                  대상: <code>{projects.find((p) => p.ref === ref)?.name ?? ref}</code> ({ref})
                </div>
                <div>
                  모드: {options.mode === "schema+data" ? "스키마+데이터" : "데이터만"}
                  {options.mode === "schema+data" && (options.ifExists === "drop" ? " · 삭제 후 재생성" : " · 있으면 건너뛰기")}
                </div>
                <div>
                  테이블 {plan.order.length}개 · 예상 {plan.order.reduce((s, n) => s + (rowCounts[n] ?? 0), 0).toLocaleString()}행
                </div>
              </div>
              {sameProject && <Alert>대상 프로젝트가 원본과 같습니다. 실행하지 마세요.</Alert>}
              {needsDropConfirm && !dropConfirmed && <Alert>4단계에서 삭제 확인 체크박스를 선택해야 실행할 수 있습니다.</Alert>}
              {showPreview && (
                <pre className="max-h-96 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">{previewSql}</pre>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void start()} disabled={!canRun || sameProject}>
                  {running ? "실행 중…" : summary ? "다시 실행" : "복사 시작"}
                </Button>
                {running && (
                  <Button variant="danger" onClick={stop} disabled={stopRequested}>
                    {stopRequested ? "중지 중…" : "중지"}
                  </Button>
                )}
                {!running && (
                  <Button variant="secondary" onClick={() => setStep(4)}>
                    ← 이전
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {(running || summary || logs.length > 0) && (
            <Card title="진행 상황">
              <div className="space-y-4">
                <div>
                  <div className="mb-1 flex justify-between text-xs text-slate-500">
                    <span>전체 진행률</span>
                    <span>{Math.round(overall * 100)}%</span>
                  </div>
                  <ProgressBar value={overall} />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800">
                        <th className="py-1.5 pr-2">테이블</th>
                        <th className="py-1.5 pr-2">상태</th>
                        <th className="py-1.5 pr-2 text-right">복사 / 전체</th>
                        <th className="w-40 py-1.5">진행</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.order.map((n) => {
                        const p = progress[n];
                        const total = p?.total ?? rowCounts[n] ?? null;
                        return (
                          <tr key={n} className="border-b border-slate-100 dark:border-slate-800/60">
                            <td className="py-1.5 pr-2 font-mono text-xs">{n}</td>
                            <td className="py-1.5 pr-2" title={p?.error}>
                              <StatusBadge status={p?.status ?? "pending"} />
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">
                              {(p?.copied ?? 0).toLocaleString()} / {total == null ? "?" : total.toLocaleString()}
                            </td>
                            <td className="py-1.5">
                              <ProgressBar value={p?.status === "done" ? 1 : total ? (p?.copied ?? 0) / total : 0} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {summary && (
                  <Alert tone={summary.failed.length || summary.stopped ? "amber" : "green"}>
                    <div className="font-semibold">{summary.stopped ? "중단됨" : summary.failed.length ? "일부 실패와 함께 완료" : "완료"}</div>
                    <div>
                      성공 {summary.succeeded.length}개 · 실패 {summary.failed.length}개 · 건너뜀 {summary.skipped.length}개 · 총 {summary.totalRows.toLocaleString()}행 ·
                      경고 {summary.warnings} · 오류 {summary.errors} · {(summary.elapsedMs / 1000).toFixed(1)}초
                    </div>
                    {summary.failed.length > 0 && <div>실패: {summary.failed.join(", ")}</div>}
                  </Alert>
                )}
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                    <span>로그</span>
                    <button type="button" className="underline" onClick={() => void navigator.clipboard?.writeText(logs.map((l) => `[${l.time}] ${l.level.toUpperCase()} ${l.message}`).join("\n"))}>
                      로그 복사
                    </button>
                  </div>
                  <div ref={logBox} className="h-64 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-xs leading-relaxed">
                    {logs.map((l) => (
                      <div
                        key={l.id}
                        className={cx(
                          "whitespace-pre-wrap break-words",
                          l.level === "error" && "text-red-400",
                          l.level === "warn" && "text-amber-300",
                          l.level === "success" && "text-emerald-400",
                          l.level === "info" && "text-slate-300",
                        )}
                      >
                        <span className="text-slate-500">[{l.time}]</span> {l.message}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </main>
  );
}

// ==========================================================================
// 하위 컴포넌트
// ==========================================================================

function Limitations() {
  return (
    <details open className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <summary className="cursor-pointer font-semibold">⚠ 제한사항</summary>
      <ul className="mt-2 list-disc space-y-0.5 pl-5">
        <li>
          <b>anon 키 모드</b>에서는 RLS 정책이 허용하는 행만 읽을 수 있습니다. 정책에 막힌 행은 복사되지 않습니다. (service_role 모드는 RLS를
          우회해 모든 행을 읽습니다.)
        </li>
        <li>PostgREST로 노출된 <code>public</code> 스키마의 테이블만 대상입니다.</li>
        <li>함수, 트리거, RLS 정책, 뷰 정의, 인덱스(PK 제외), CHECK/UNIQUE 제약, FK의 ON DELETE 동작, Storage, auth.users 등은 복사되지 않습니다.</li>
        <li>컬럼 타입·기본값은 OpenAPI 정보에서 추정하므로 원본과 다를 수 있습니다 (SQL 미리보기로 확인하세요).</li>
        <li>복사 중 원본 데이터가 바뀌면 결과가 일관되지 않을 수 있습니다.</li>
      </ul>
    </details>
  );
}

function SourceModeBadge({ mode }: { mode: SourceMode }) {
  return <Badge tone={mode === "anon" ? "slate" : "red"}>{SOURCE_MODE_LABEL[mode]}</Badge>;
}

function ServiceRoleWarning() {
  return (
    <Alert>
      <div className="font-semibold">⚠ service_role 키 주의</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>
          <b>RLS를 우회</b>합니다. 정책과 관계없이 <b>모든 행</b>(다른 사용자의 개인 데이터 포함)이 읽힙니다.
        </li>
        <li>
          키가 유출되면 <b>DB 전체에 대한 읽기/쓰기 권한</b>이 넘어갑니다. 키는 서버에만 보관되며 브라우저로 전달되지 않습니다.
        </li>
        <li>
          이 앱을 <b>공개 서버에 배포하지 마세요.</b> 로컬/신뢰할 수 있는 환경에서만 사용하세요.
        </li>
        <li>env 모드는 로그인한 Supabase 계정이 원본 프로젝트에 접근할 수 있을 때만 동작합니다. 직접 입력한 키는 입력한 URL에만 사용됩니다.</li>
      </ul>
    </Alert>
  );
}

function ModeOption({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <label className={cx("flex items-start gap-2", disabled && "opacity-50")}>
      <input type="radio" name="source-mode" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={checked} onChange={onChange} disabled={disabled} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>
      </span>
    </label>
  );
}

function ColumnPreview({ table, countError }: { table: TableDef; countError?: string }) {
  return (
    <div className="bg-slate-50 px-3 pb-3 dark:bg-slate-950/50">
      {countError && <div className="mb-2 text-xs text-red-600">{countError}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 pr-3">컬럼</th>
              <th className="py-1 pr-3">원본 타입</th>
              <th className="py-1 pr-3">생성 타입</th>
              <th className="py-1 pr-3">제약</th>
              <th className="py-1">기본값</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((c) => {
              const m = mapColumnType(c, table.name);
              const d = renderDefault(c, m, table.name);
              return (
                <tr key={c.name} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="py-1 pr-3 font-mono">{c.name}</td>
                  <td className="py-1 pr-3 font-mono text-slate-500">{c.format || c.jsonType}</td>
                  <td className={cx("py-1 pr-3 font-mono", m.warnings.length > 0 && "text-amber-600")} title={m.warnings.join("\n")}>
                    {m.sql}
                  </td>
                  <td className="space-x-1 py-1 pr-3">
                    {c.isPk && <Badge tone="green">PK</Badge>}
                    {c.notNull && <Badge>NOT NULL</Badge>}
                    {c.fk && (
                      <Badge tone="blue">
                        → {c.fk.table}.{c.fk.column}
                      </Badge>
                    )}
                  </td>
                  <td className={cx("py-1 font-mono", d.warning && "text-amber-600")} title={d.warning}>
                    {d.identity ? "identity" : d.expr ?? (d.warning ? `(건너뜀) ${String(c.default)}` : "")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: TableProgress["status"] }) {
  switch (status) {
    case "running":
      return <Badge tone="blue">진행</Badge>;
    case "done":
      return <Badge tone="green">완료</Badge>;
    case "failed":
      return <Badge tone="red">실패</Badge>;
    case "skipped":
      return <Badge tone="amber">건너뜀</Badge>;
    default:
      return <Badge>대기</Badge>;
  }
}

function Radio({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input type="radio" className="h-4 w-4 accent-emerald-600" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
