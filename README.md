# Supabase DB 복사

원본(source) Supabase 프로젝트의 `public` 스키마 테이블 구조와 데이터를 대상(target) Supabase 프로젝트로 복사하는 Next.js(App Router) 웹 앱입니다.

- 원본: PostgREST를 통해 스키마/행을 읽습니다. 읽기 방식은 3가지입니다 ([원본 읽기 방식](#원본-읽기-방식)).
  - `anon key (RLS 적용)` — 브라우저가 anon 키로 직접 읽음 (기본)
  - `service_role (env)` — 서버가 `SUPABASE_SERVICE_ROLE_KEY`로 읽음 (RLS 우회)
  - `service_role (직접 입력)` — 화면에서 입력한 키를 서버의 httpOnly 쿠키에 저장하고 서버가 읽음 (RLS 우회)
- 대상: Supabase **Personal Access Token**으로 로그인한 뒤 Management API(`/v1/projects/{ref}/database/query`)로 SQL을 실행합니다. 토큰은 서버의 httpOnly 쿠키에만 저장됩니다.

## 설치 및 실행

```bash
npm install
cp .env.example .env.local   # 원본 프로젝트 URL / anon 키 입력
npm run dev                  # http://localhost:3000
```

`.env.local`

```env
NEXT_PUBLIC_SUPABASE_URL=https://<원본-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<원본 anon 키>

# 선택: service_role (env) 모드 — NEXT_PUBLIC_ 접두사 금지
SUPABASE_SERVICE_ROLE_KEY=<원본 service_role 키>
# 선택: 원본이 *.supabase.co가 아닐 때(자체 호스팅/로컬) env 모드를 계정 확인 없이 허용
ALLOW_UNVERIFIED_SERVICE_ROLE=true
```

환경 변수가 없어도 화면에서 URL과 키를 직접 입력할 수 있습니다.

기타 명령:

| 명령 | 설명 |
| --- | --- |
| `npm run build` / `npm start` | 프로덕션 빌드 / 실행 |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest 단위 테스트 (`lib/ddl.test.ts`, `lib/source-core.test.ts`) |

## 사용 방법

1. **계정 로그인** — [토큰 발급 페이지](https://supabase.com/dashboard/account/tokens)에서 `sbp_...` 토큰을 만들어 로그인합니다. 대상 쓰기에 필요하고, `service_role (env)` 모드에서는 이 계정이 원본 프로젝트에 접근할 수 있는지 확인하는 데 쓰입니다. 로그인되어 있으면 2단계로 바로 이동합니다.
   - 로그인을 첫 단계로 둔 이유: 어차피 실행 전에 필요하고, env 모드의 접근 확인이 로그인에 의존하므로 순서대로 진행하면 “먼저 로그인하세요” 같은 되돌아가기가 생기지 않습니다. anon 모드는 로그인 없이 원본 단계를 먼저 진행할 수도 있습니다.
2. **원본(Source)** — 읽기 방식을 고릅니다. anon 모드는 환경 변수 값으로 자동 연결됩니다. 다른 프로젝트를 쓰려면 URL/키를 바꾸고 “연결 및 스키마 불러오기”를 누릅니다. 연결된 읽기 방식은 이후 모든 단계 상단 표시줄과 실행 로그에 표시됩니다.
3. **대상(Target)** — 드롭다운에서 대상 프로젝트를 고릅니다. “연결 테스트”로 SQL 실행 권한을 확인할 수 있습니다.
4. **테이블 선택** — 행 수와 컬럼 미리보기(원본 타입 → 생성될 타입, PK/FK/NOT NULL, 기본값)를 확인하며 테이블을 고르고 옵션을 정합니다.
   - 모드: `스키마+데이터` / `데이터만`
   - 이미 있는 테이블: `건너뛰기(CREATE TABLE IF NOT EXISTS)` / `삭제 후 재생성(DROP ... CASCADE)` — 삭제는 확인 체크박스가 필요합니다.
   - `기존 데이터 비우기(TRUNCATE ... RESTART IDENTITY)`
   - `FK/트리거 비활성화(session_replication_role = replica)` (기본 켜짐)
   - `대상 테이블 RLS 활성화` (기본 켜짐, 정책은 복사되지 않음)
   - `중복 행 무시(ON CONFLICT DO NOTHING)`, `오류 시 다음 테이블 계속`
5. **실행** — “SQL 미리보기”로 생성될 SQL을 확인/복사한 뒤 “복사 시작”. 테이블별 상태(대기/진행/완료/실패), 복사 행 수, 전체 진행률, 실시간 로그가 표시되며 “중지”로 배치 사이에서 멈출 수 있습니다.

## 원본 읽기 방식

| 방식 | 키 위치 | 요청 경로 | RLS | 조건 |
| --- | --- | --- | --- | --- |
| anon key (RLS 적용) | 브라우저 (공개 키) | 브라우저 → PostgREST | 적용 | 없음 |
| service_role (env) | 서버 환경 변수 `SUPABASE_SERVICE_ROLE_KEY` | 브라우저 → `/api/source/*` → PostgREST | **우회** | PAT 로그인 + 계정이 원본 프로젝트에 접근 가능, 화면 URL = `NEXT_PUBLIC_SUPABASE_URL` |
| service_role (직접 입력) | 서버가 설정한 httpOnly 쿠키 (URL과 함께 저장, 8시간) | 브라우저 → `/api/source/*` → PostgREST | **우회** | 화면 URL = 키를 저장할 때의 URL |

세 방식 모두 같은 코드(`lib/source-core.ts`)로 select 목록(`bigint`/`numeric` → `::text`), PK 정렬, `offset`/`limit` 페이지(1000행), `Prefer: count=exact` 행 수 조회를 만듭니다. 실행기(`lib/runner.ts`)는 `SourceReader` 인터페이스만 사용하므로 방식과 무관하게 동작합니다.

서버 라우트:

| 라우트 | 내용 |
| --- | --- |
| `GET /api/source/status` | 방식별 사용 가능 여부 (env 키 설정 여부·URL·접근 확인 결과, 저장된 쿠키 키의 URL, 로그인 여부). 키 값은 포함하지 않음 |
| `GET /api/source/openapi?mode=env\|cookie&url=` | OpenAPI 조회 → 파싱된 테이블 목록 |
| `GET /api/source/count?mode=&url=&table=` | 행 수 |
| `GET /api/source/rows?mode=&url=&table=&from=&size=` | 한 페이지 (size ≤ 1000) — PostgREST JSON을 그대로 전달 |
| `POST /api/source/key` `{url, key}` | 키를 그 URL로 OpenAPI 조회해 확인한 뒤 쿠키에 저장 (anon/publishable 키는 거부) |
| `POST /api/source/forget` | 저장된 키 쿠키 삭제 |

### service_role 보안 모델

- **키는 브라우저로 가지 않습니다.** env 키는 `NEXT_PUBLIC_` 접두사가 없어 클라이언트 번들에 포함되지 않고, 직접 입력한 키는 한 번 POST된 뒤 `httpOnly`, `sameSite=strict`, (프로덕션) `secure` 쿠키에만 있습니다. 응답 본문·로그에 키를 넣지 않습니다.
- **키 유출 방지:** 요청 대상 URL은 항상 서버가 정합니다 — env 키는 `NEXT_PUBLIC_SUPABASE_URL`(정규화 비교)로만, 쿠키 키는 저장 시 묶인 URL로만 보냅니다. 요청의 `url` 파라미터는 “화면에 표시된 URL과 같은지” 확인하는 데만 쓰이며 다르면 거부(409)합니다. 화면에서 원본 URL을 바꾸면 env 모드는 사용할 수 없습니다. PostgREST 요청은 리다이렉트를 따라가지 않습니다(`redirect: "error"`) — `apikey` 헤더가 다른 호스트로 넘어가지 않도록.
- **경로 주입 방지:** `table`은 서버가 그 키로 받은 OpenAPI 테이블 목록(60초 캐시)에 있는 이름만 허용하고, 형식 검사(63바이트 이하, 제어문자/`.`/`..` 금지) 후 `encodeURIComponent`로 경로에 넣습니다. select/order는 클라이언트 값이 아니라 서버가 스키마로 직접 만듭니다.
- **env 키 접근 게이트:** env 키 라우트는 앱에 접근할 수 있는 누구에게나 DB 전체 읽기를 열어 주므로, 로그인한 PAT 계정의 `GET /v1/projects`에 원본 ref(`https://<ref>.supabase.co`)가 있어야 합니다(토큰별 60초 메모리 캐시). 원본이 `*.supabase.co`가 아니면(자체 호스팅/로컬) 확인할 방법이 없으므로 `ALLOW_UNVERIFIED_SERVICE_ROLE=true`일 때만 허용합니다. 직접 입력한 키는 사용자가 키를 이미 가지고 있으므로 게이트가 없습니다.
- **출처 검사:** 모든 `/api/source/*` 라우트는 기존 `Origin` 검사 + `Sec-Fetch-Site: cross-site` 거부를 적용합니다(403).

제한/주의:

- 직접 입력 모드에서는 서버가 사용자가 입력한 URL로 요청합니다(`{url}/rest/v1/...`, GET/HEAD). 즉 앱에 접근할 수 있는 사람은 서버의 네트워크 위치에서 그 경로로 요청을 보낼 수 있으므로(SSRF) **공개 배포하지 마세요.**
- `ALLOW_UNVERIFIED_SERVICE_ROLE=true`이면 접근 제어가 없습니다. 로컬 전용입니다.
- 접근 확인 캐시(60초) 때문에 계정 권한이 회수된 뒤에도 최대 60초 동안 접근이 유지될 수 있습니다.
- 서버 라우트는 `NEXT_PUBLIC_SUPABASE_URL`을 실행 시점 환경 변수에서 읽지만, 화면의 기본 URL은 빌드 시점 값입니다. 둘이 다르면 env 모드는 “URL이 다름”으로 거부되므로(안전한 방향), 원본 단계의 “환경 변수 URL 사용” 버튼을 누르거나 다시 빌드하세요.
- 서버 경유이므로 행 읽기가 브라우저 직접 방식보다 약간 느립니다. 서버리스 환경에서는 요청당 실행 시간 제한이 적용됩니다(페이지 단위 요청이라 보통 문제없음).

## 동작 방식

### 스키마 조회
`GET {url}/rest/v1/` (헤더 `apikey`, JWT 키면 `Authorization: Bearer <key>`)의 OpenAPI 문서에서 `definitions`를 파싱합니다.

- `format` → Postgres 타입 (`uuid`, `text`, `timestamp with time zone`, `text[]`, …)
- `enum` → enum 타입 (`DO` 블록으로 없을 때만 `CREATE TYPE`)
- `required` → `NOT NULL`
- `description`의 `<pk/>` → 기본 키(복합 키 지원), `<fk table='x' column='y'/>` → 외래 키
- `default` → 안전한 기본값만 복사 (`now()`, `gen_random_uuid()`, 리터럴 등). `nextval(...)`은 정수 컬럼이면 `generated by default as identity`로 바꾸고, 그 밖의 표현식은 경고 후 생략
- 알 수 없는 배열(`ARRAY`)은 `jsonb`, 알 수 없는 타입은 `text`로 대체(경고 표시)
- PK가 없고 쓰기 메서드가 없는 항목은 “뷰?”로 표시하고 기본 선택에서 제외합니다.

### 실행 순서
1. enum 타입 생성 → (삭제 모드) `DROP TABLE ... CASCADE` → `CREATE TABLE IF NOT EXISTS` (FK 의존성 위상 정렬 순서, 순환 참조는 경고 후 마지막에 배치)
2. FK를 별도 `ALTER TABLE ... ADD CONSTRAINT` (이미 있으면 무시하는 `DO` 블록)
3. RLS 활성화, (선택) TRUNCATE
4. 데이터: 원본에서 `offset`/`limit`로 1000행씩(PK 정렬) 읽어, 500행/약 800KB 이하 배치로 나눠 삽입
   ```sql
   set session_replication_role = replica;
   insert into "public"."t" ("a", "b") overriding system value
   select "a", "b" from json_populate_recordset(null::"public"."t", $j_xxxxxx$[...]$j_xxxxxx$);
   reset session_replication_role;
   ```
   dollar-quote 태그는 페이로드에 없는 무작위 값으로 생성합니다. `bigint`/`numeric`은 JS 정밀도 손실을 막기 위해 원본에서 `::text`로 읽습니다.
5. 시퀀스/identity 재설정: 각 테이블의 시퀀스를 `max(col)`로 `setval` (비어 있으면 1, `is_called=false`)

429/5xx 응답은 지수 백오프로 재시도합니다.

### 코드 구조

| 경로 | 내용 |
| --- | --- |
| `lib/ddl.ts` | 순수 함수: OpenAPI 파싱, 타입 매핑, DDL/INSERT 생성, 위상 정렬, 배치 분할 |
| `lib/ddl.test.ts` | Vitest 단위 테스트 |
| `lib/source-core.ts` | 원본 공통 로직 (URL 정규화/비교, ref 추출, 모드 결정, 테이블 이름 검증, select/order/페이지 쿼리, PostgREST 요청) — 브라우저/서버 공용, 비밀 없음 |
| `lib/source-core.test.ts` | 위 순수 함수 테스트 |
| `lib/source.ts` | 브라우저 `SourceReader` (anon 직접 / 서버 프록시) |
| `lib/source-server.ts` | service_role 서버 전용 로직 (`server-only`): 키 결정, 접근 게이트, OpenAPI 캐시 |
| `app/api/source/*` | `status`, `openapi`, `count`, `rows`, `key`, `forget` 라우트 |
| `lib/runner.ts` | 실행기 (진행 상황/로그/중지/재시도) — 브라우저 |
| `lib/management.ts` | Management API 호출, 쿠키 설정 — 서버 전용 |
| `app/api/target/*` | `login`, `logout`, `projects`, `query` 라우트 |
| `components/Migrator.tsx` | 5단계 UI |

## 보안

- Personal Access Token은 계정의 **모든 프로젝트**에 대한 권한을 가집니다. 신뢰할 수 있는 환경(로컬)에서만 실행하세요.
- 토큰은 `httpOnly`, `sameSite=strict`, 프로덕션에서 `secure` 쿠키(8시간)로만 저장되며 클라이언트 JS에 노출되지 않습니다. 사용 후 로그아웃하세요.
- service_role 키는 **RLS를 우회하고 DB 전체 권한**을 가집니다. 보안 모델은 [service_role 보안 모델](#service_role-보안-모델)을 보세요. 직접 입력한 키는 사용 후 “저장된 키 삭제”를 누르세요.
- `/api/target/query`는 로그인한 사용자가 선택한 프로젝트에 임의 SQL을 실행하는 프록시입니다. 이 앱을 공개 서버에 배포하지 마세요.
- POST 라우트와 `/api/source/*`는 `Origin` 헤더가 Host와 다르면 거부합니다.

## 제한사항

- **anon 키 모드는 RLS가 허용하는 행만 읽습니다.** 정책에 막힌 행은 복사되지 않습니다(누락된 부모 행 때문에 FK 추가가 실패할 수 있음). 모든 행이 필요하면 service_role 모드를 쓰세요.
- PostgREST로 노출된 **`public` 스키마의 테이블만** 대상입니다.
- 함수, 트리거, RLS 정책, 뷰 정의, 인덱스(PK 제외), CHECK/UNIQUE 제약, FK의 ON DELETE/UPDATE 동작, 컬럼 코멘트, Storage, `auth.users` 등은 **복사되지 않습니다.**
- 타입/기본값은 OpenAPI 정보로 추정하므로 원본과 다를 수 있습니다. 실행 전 SQL 미리보기를 확인하세요.
- 일부 Supabase 프로젝트는 anon 키로 OpenAPI 스키마 조회를 막습니다. 이 경우 조회 거부 오류가 표시됩니다(service_role 모드로 우회 가능).
- PK가 없는 테이블은 페이지 순서가 보장되지 않아, 복사 중 원본이 바뀌면 누락/중복이 생길 수 있습니다.
- TRUNCATE는 CASCADE 없이 실행되므로, 선택하지 않은 테이블이 FK로 참조하면 실패합니다.
- `session_replication_role` 설정 권한이 없는 환경에서는 해당 옵션을 끄세요(이 경우 FK 순서대로 삽입됩니다).
