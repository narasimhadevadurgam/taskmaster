# TaskMaster: A Collaborative Task Tracking System

TaskMaster is a REST API backend for team task tracking and collaboration. Users
register and authenticate, organize work into projects with members, create and
assign tasks, collaborate through comments and file attachments, and receive
real-time notifications when a task is assigned or updated. An optional pluggable
LLM client generates task descriptions, offline by default.

> **This repository is public-ready.** One command to run the whole stack:
> `docker compose up --build` (API on `http://localhost:3000`, `GET /health` → `{"status":"ok"}`).

## Stack

- **Runtime:** Node.js 20 LTS, ES modules
- **Language:** TypeScript (strict mode)
- **Web:** Express 4
- **Database:** PostgreSQL 15 via `pg` with hand-written parameterized SQL (no ORM)
- **Auth:** JWT (`jsonwebtoken`) + `bcrypt`; server-side token blocklist for real logout
- **Validation:** `zod` on every request body/params/query
- **Uploads:** `multer` to local disk (metadata in DB)
- **Real-time:** `socket.io` v4 (JWT handshake auth, per-user rooms)
- **AI:** pluggable `LlmClient` — deterministic offline **mock** (default) or **Ollama**
- **Tests:** Vitest v1 against a real Postgres, run serially
- **Containers / CI:** multi-stage Dockerfile, docker-compose, GitHub Actions with a `postgres:15` service

## Verification status

The full suite was run against a local `postgres:15` (via `docker compose up -d db`)
from an empty database: **7 test files, 52 tests, all passing, 0 skipped** (the
DB/socket integration suites executed — `auth`, `projects/tasks/comments/attachments`,
and `notifications + AI`). The suite was run twice back-to-back with identical
results to confirm stability. `tsc` builds clean, `npm run seed` populates the
real DB (20 users / 5 projects / 200 tasks / 191 comments), and `docker compose up`
brings up **db + api** with migrate-on-start and `GET /health` returning
`{"status":"ok"}`. CI (`.github/workflows/ci.yml`) runs the same build → migrate →
test flow against a `postgres:15` service on every push/PR.

## Prerequisites

- Docker + Docker Compose (for the canonical run path), **or**
- Node.js 20+ and a reachable PostgreSQL 15 (for local dev)

## Canonical run path: `docker compose up`

```bash
docker compose up --build
```

This starts:

- **db** — `postgres:15` (`taskmgr` / `taskmgr` / `task_manager`), published on `5432`, with a `pg_isready` healthcheck.
- **api** — built from the `Dockerfile`, waits for the db to be healthy, **applies migrations on startup**, then serves on `3000`. It runs with `LLM_PROVIDER=mock`, so the whole stack runs **fully offline** (no Ollama required).

Once up:

```bash
curl http://localhost:3000/health      # -> {"status":"ok"}
```

If host port `3000` (or `5432`) is already in use on your machine, either stop
the process using it or map a different host port, e.g.:

```bash
# PowerShell example: publish the API on 3100 instead of 3000
docker compose run --service-ports -e PORT=3000 --publish 3100:3000 api
```

The `Dockerfile` intentionally omits a `# syntax=` frontend directive and uses
only built-in build features (multi-stage, `COPY --from`), so the build does not
trigger the newer Buildx sandbox that would otherwise prompt for an
`--allow=fs.read=Dockerfile` privilege grant. Plain `docker compose up` works on a
stock Docker Desktop install.

## Local development (without Docker)

```bash
npm install

# Point DATABASE_URL at a reachable Postgres, e.g.:
#   docker compose up db        (just the database)
# then set DATABASE_URL + JWT_SECRET (copy .env.example to .env).

npm run migrate:dev   # build the schema from empty (tsx src/db/migrate.ts)
npm run seed          # optional: ~20 users, ~5 projects, ~200 tasks, comments
npm run dev           # start the API with tsx (hot source execution)
```

Scripts (all Node/`cross-env`-based, identical on Windows and Linux):

| script | what it does |
|---|---|
| `npm run build` | `tsc` → `dist/` |
| `npm run migrate` | run compiled migration runner (`dist/src/db/migrate.js`) — used by Docker/CI |
| `npm run migrate:dev` | run the migration runner from source via `tsx` |
| `npm run seed` | populate a migrated DB with sample data (re-runnable) |
| `npm run dev` | run the server from source via `tsx` |
| `npm test` | `cross-env LLM_PROVIDER=mock vitest run` |

The migration runner locates `migrations/` by walking up from its own location,
so it finds the SQL files whether run from source (`src/db/migrate.ts`), from the
compiled output (`dist/src/db/migrate.js`), or inside the Docker image
(`/app/migrations`). The seed script truncates the domain tables first, so it is
safe to re-run; it never writes attachment files to disk.

## Environment variables

All variables are listed in [`.env.example`](./.env.example). `.env` is
gitignored and no secrets are committed.

| var | required | default | purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `JWT_SECRET` | yes | — | HMAC secret for JWT (min 16 chars) |
| `PORT` | no | `3000` | HTTP port |
| `LLM_PROVIDER` | no | `mock` | `mock` or `ollama` |
| `OLLAMA_URL` | no | `http://localhost:11434` | Ollama base URL (ollama only) |
| `OLLAMA_MODEL` | no | `llama3.1:8b` | Ollama model (ollama only) |
| `UPLOAD_DIR` | no | `uploads` | local upload directory |
| `MAX_UPLOAD_BYTES` | no | `10485760` (10 MB) | upload size cap |
| `NODE_ENV` | no | `development` | `development` / `test` / `production` |

## User stories → how it's satisfied

| user story | how TaskMaster satisfies it |
|---|---|
| Create a new account | `POST /auth/register` (name, email, bcrypt-hashed password) |
| Log in securely | `POST /auth/login` → JWT; credentials checked against the bcrypt hash |
| View and update my profile | `GET /users/me`, `PATCH /users/me` (name / email / password) |
| Create a task (title, description, due date) | `POST /tasks` |
| View tasks assigned to me | `GET /tasks?assignee=me` |
| Mark a task completed | `PATCH /tasks/:id` with `{ "status": "completed" }` |
| Assign a task to a team member | `PATCH /tasks/:id` with `{ "assignee_id": <id> }` (assignee must be a project member) |
| Filter tasks by status | `GET /tasks?status=open|in_progress|completed` |
| Search tasks by title/description | `GET /tasks?q=<text>` (literal substring, LIKE-escaped) |
| Comments and attachments on tasks | `POST/GET /tasks/:id/comments`, `POST/GET /tasks/:id/attachments`, `GET /attachments/:id/download` |
| Create a team/project and invite members | `POST /projects`, `POST /projects/:id/members` (by `user_id` or `email`) |
| Securely log out | `POST /auth/logout` (adds the token's `jti` to a server-side blocklist) |
| Real-time notifications (optional extension) | socket.io `notification` event on assignment/update, persisted with a REST fallback — **implemented** |
| Generative-AI task descriptions (optional) | `POST /ai/task-description` via pluggable `LlmClient` — **implemented**, mock default |

## Data model / ER overview

Eight domain tables (see [`migrations/0001_init.sql`](./migrations/0001_init.sql)):

- **users** — account; unique `email` (CITEXT), bcrypt `password_hash`.
- **token_blocklist** — invalidated JWT `jti`s (logout); keyed by UUID.
- **projects** — owned by a user (`owner_id`, `ON DELETE RESTRICT`).
- **project_members** — M:N users ↔ projects, PK `(project_id, user_id)`, `role` owner/member.
- **tasks** — `title`, `description`, `status` (enum), `priority` (enum, nullable), `due_date`, `creator_id`, nullable `assignee_id` (`ON DELETE SET NULL`), nullable `project_id` (`ON DELETE SET NULL`).
- **comments** — belong to a task (`ON DELETE CASCADE`), authored by a user.
- **attachments** — file metadata for a task (`ON DELETE CASCADE`); bytes live under `UPLOAD_DIR`.
- **notifications** — one row per recipient; `type`, JSONB `payload`, `read` flag.

Relationships: a user owns many projects and is a member of many; a project has
many tasks; a task has many comments and attachments; a user receives many
notifications.

## API overview

Base path has no version prefix. Every endpoint except `GET /health` and
`POST /auth/*` requires `Authorization: Bearer <jwt>`. Every request carries an
`X-Request-Id` (reused if a valid UUID is supplied, else generated) echoed in the
response and in every error body. List endpoints accept `limit` (1–100, default
20) and `offset` (≥0) and return `{ data, pagination: { limit, offset, total } }`.

| method | path | auth | request body | success response |
|---|---|---|---|---|
| GET | `/health` | none | — | `{ status: "ok" }` (503 if DB down) |
| POST | `/auth/register` | none | `{ name, email, password }` | `201 { user }` |
| POST | `/auth/login` | none | `{ email, password }` | `200 { token, user }` |
| POST | `/auth/logout` | JWT | — | `204` |
| GET | `/users/me` | JWT | — | `200 { user }` |
| PATCH | `/users/me` | JWT | `{ name?, email?, password? }` | `200 { user }` |
| POST | `/projects` | JWT | `{ name, description? }` | `201 { project }` (caller becomes owner) |
| GET | `/projects` | JWT | — | `200 { data, pagination }` |
| GET | `/projects/:id` | JWT (member) | — | `200 { project, members }` |
| POST | `/projects/:id/members` | JWT (owner) | `{ user_id }` **or** `{ email }` | `201 { member }` |
| POST | `/tasks` | JWT | `{ title, description?, status?, priority?, due_date?, assignee_id?, project_id? }` | `201 { task }` |
| GET | `/tasks` | JWT | query filters (below) | `200 { data, pagination }` |
| GET | `/tasks/:id` | JWT | — | `200 { task }` |
| PATCH | `/tasks/:id` | JWT | any task field(s) | `200 { task }` |
| DELETE | `/tasks/:id` | JWT | — | `204` (creator or project owner) |
| POST | `/tasks/:id/comments` | JWT | `{ body }` | `201 { comment }` |
| GET | `/tasks/:id/comments` | JWT | — | `200 { data, pagination }` |
| POST | `/tasks/:id/attachments` | JWT | `multipart/form-data`, field `file` | `201 { attachment }` |
| GET | `/tasks/:id/attachments` | JWT | — | `200 { data, pagination }` |
| GET | `/attachments/:id/download` | JWT | — | `200` file stream |
| GET | `/notifications` | JWT | `?read=true|false` | `200 { data, pagination }` |
| PATCH | `/notifications/:id` | JWT | `{ read: true }` | `200 { notification }` |
| POST | `/notifications/read-all` | JWT | — | `200 { updated }` |
| POST | `/ai/task-description` | JWT | `{ input, title? }` | `200 { description }` |

`GET /tasks` filters: `status`, `assignee` (`me` or user id), `project`,
`q` (literal substring search over title/description), `sort`
(`created_at|due_date|priority`), `order` (`asc|desc`), `limit`, `offset`.

### Uniform error shape

Every error, on every endpoint, uses:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "human readable", "request_id": "uuid" } }
```

Validation errors additionally include a `details` array of `{ path, message }`.

### Error-code catalog

| code | HTTP | meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | body/params/query failed validation |
| `UNAUTHENTICATED` | 401 | missing/invalid/blocklisted token or bad credentials |
| `FORBIDDEN` | 403 | authenticated but not permitted for the action |
| `NOT_FOUND` | 404 | resource absent or not visible to the caller |
| `CONFLICT` | 409 | unique violation (duplicate email, duplicate member) |
| `PAYLOAD_TOO_LARGE` | 413 | upload exceeds `MAX_UPLOAD_BYTES` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | non-multipart request on an upload endpoint |
| `AI_UNAVAILABLE` | 502 | LLM provider (Ollama) unreachable or timed out |
| `SERVICE_UNAVAILABLE` | 503 | dependency down (used by `GET /health` DB check) |
| `INTERNAL` | 500 | unexpected error (generic body; details logged with `request_id`) |

## Authorization rules

- **Task visibility:** a task is visible to its creator, its assignee, or any
  member of its project. Non-visible task → `404` (so the API never leaks the
  existence of a resource you cannot see).
- **Task edit:** same set as visibility; moving a task into a non-null project
  additionally requires membership of the target project.
- **Task delete:** only the creator or the owner of the task's project.
- **Assignment invariant:** if a task belongs to a project, its assignee must be
  a current member of that project.
- **Project membership:** only the owner can add members.
- **403 vs 404:** `404` when the caller cannot see the resource; `403` only when
  the caller can see it but lacks permission for the specific action.

## Real-time notifications

Notifications are persisted in the DB (one row per recipient, written inside the
task transaction) and pushed over `socket.io` after commit. The socket emit is
best-effort — a recipient can always fetch missed events via the REST fallback.

**Client connect flow:**

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', { auth: { token: '<jwt>' } });

socket.on('notification', (n) => {
  // n = { id, user_id, type, payload, read, created_at }
  // payload = { task_id, title, status, project_id, actor_id }
});
```

An invalid/blocklisted token is rejected at the handshake with a connect error.

**REST fallback:** `GET /notifications` returns the same notification objects
(paginated, newest first); `PATCH /notifications/:id` with `{ "read": true }` and
`POST /notifications/read-all` manage read state.

## AI task-description generation

`POST /ai/task-description` with `{ "input": "...", "title"?: "..." }` returns
`{ "description": "..." }`. User input is treated strictly as data framed in a
fixed trusted template; the AI module has no database or service access
(structural prompt-safety boundary).

Provider is selected by `LLM_PROVIDER`:

- `mock` (default) — deterministic, offline, no network. Used by tests, Docker, and CI.
- `ollama` — POSTs to `${OLLAMA_URL}/api/generate` with `OLLAMA_MODEL`. On an
  unreachable provider or timeout the endpoint returns `502 AI_UNAVAILABLE`.

**Switch mock → Ollama:** set `LLM_PROVIDER=ollama` (and optionally `OLLAMA_URL` /
`OLLAMA_MODEL`), make sure Ollama is running and the model is pulled
(`ollama pull llama3.1:8b`), then restart the API. No code change required.

## Testing

```bash
npm test     # cross-env LLM_PROVIDER=mock vitest run
```

Tests run against a **real Postgres** (no DB mocks). Point `TEST_DATABASE_URL`
(or `DATABASE_URL`) at a reachable Postgres and apply migrations first
(`npm run migrate` / `npm run migrate:dev`). A Vitest global setup applies
migrations once; each test resets state by truncating the domain tables.

**Serial execution (required).** The suite shares one database, so it runs
serially. This is configured once in `vitest.config.ts`
(`pool: 'forks'`, `poolOptions.forks.singleFork: true`, `fileParallelism: false`)
— not via ad-hoc CLI flags. Do not re-enable parallelism; concurrent tests would
interfere through the shared database.

The integration suites skip themselves cleanly when no test database is
configured, so `npm test` stays green on DB-less stages while running fully
wherever a Postgres is reachable (compose db, CI `postgres:15` service, or a
local instance).

On Windows PowerShell, if `npm test` is blocked by execution policy, invoke
Vitest directly after setting the env vars:

```powershell
$env:DATABASE_URL="postgres://taskmgr:taskmgr@localhost:5432/task_manager"
$env:TEST_DATABASE_URL=$env:DATABASE_URL
$env:JWT_SECRET="test-secret-at-least-16-chars-long"
node .\node_modules\vitest\vitest.mjs run
```

## Performance & indexes

The schema creates these indexes ([`migrations/0001_init.sql`](./migrations/0001_init.sql)),
each supporting a specific access pattern:

| index | column(s) | query it supports |
|---|---|---|
| `users_email_key` (unique) | `users(email)` | login / registration lookup by email; enforces email uniqueness |
| `tasks_assignee_id_idx` | `tasks(assignee_id)` | `GET /tasks?assignee=me`, and the visibility predicate's assignee branch |
| `tasks_project_id_idx` | `tasks(project_id)` | `GET /tasks?project=…` and project-scoped visibility |
| `tasks_status_idx` | `tasks(status)` | `GET /tasks?status=…` |
| `tasks_creator_id_idx` | `tasks(creator_id)` | the visibility predicate's creator branch |
| `comments_task_id_idx` | `comments(task_id)` | `GET /tasks/:id/comments` |
| `attachments_task_id_idx` | `attachments(task_id)` | `GET /tasks/:id/attachments` |
| `project_members_user_id_idx` | `project_members(user_id)` | "projects I belong to" (used by the task visibility subquery) |
| `project_members_project_id_idx` | `project_members(project_id)` | listing a project's members |
| `notifications_user_read_idx` | `notifications(user_id, read)` | `GET /notifications?read=…` |
| `token_blocklist_expires_at_idx` | `token_blocklist(expires_at)` | expiry cleanup of blocklisted tokens |

### EXPLAIN ANALYZE: the `GET /tasks` list query

Run against the seeded database (20 users / 5 projects / 200 tasks) for user `1`,
this is the exact list query — the visibility predicate with
`ORDER BY created_at DESC NULLS LAST, id DESC` and `LIMIT 20 OFFSET 0`:

```
 Limit  (cost=24.90..24.95 rows=20 width=112) (actual time=0.135..0.137 rows=20 loops=1)
   ->  Sort  (cost=24.90..25.19 rows=114 width=112) (actual time=0.133..0.135 rows=20 loops=1)
         Sort Key: t.created_at DESC NULLS LAST, t.id DESC
         Sort Method: top-N heapsort  Memory: 32kB
         ->  Seq Scan on tasks t  (cost=14.37..21.87 rows=114 width=112) (actual time=0.032..0.072 rows=99 loops=1)
               Filter: ((creator_id = 1) OR (assignee_id = 1) OR (hashed SubPlan 1))
               Rows Removed by Filter: 101
               SubPlan 1
                 ->  Bitmap Heap Scan on project_members  (cost=4.21..14.35 rows=7 width=8) (actual time=0.015..0.016 rows=3 loops=1)
                       Recheck Cond: (user_id = 1)
                       Heap Blocks: exact=1
                       ->  Bitmap Index Scan on project_members_user_id_idx  (cost=0.00..4.21 rows=7 width=0) (actual time=0.008..0.008 rows=3 loops=1)
                             Index Cond: (user_id = 1)
 Planning Time: 0.446 ms
 Execution Time: 0.178 ms
```

**Reading the plan:** the "projects I belong to" subquery uses
`project_members_user_id_idx` (Bitmap Index Scan), exactly the index that column
exists for. The `tasks` table is read with a **Seq Scan** here — at 200 rows the
whole table fits in a single page, so the planner correctly judges a sequential
scan cheaper than three separate index probes plus a bitmap OR. The `tasks(creator_id)`,
`tasks(assignee_id)` and `tasks(project_id)` indexes are present for the point and
filtered lookups (e.g. `assignee=me`, `project=…`) and for the visibility branches
once the table grows past the point where a full scan is the cheaper plan. The
result is a top-N heapsort of 20 rows in well under a millisecond. This is the
honest picture at seed scale; on a large `tasks` table the same predicate shifts
to index-driven access on those columns.

## Design decisions & trade-offs

- **Raw parameterized SQL, no ORM.** Keeps the money-path SQL explicit and
  reviewable; every query is parameterized against injection.
- **One visibility predicate.** `GET /tasks` builds the creator/assignee/member
  predicate once and reuses it byte-identical for the data `SELECT` and the
  `COUNT(*)`, so the page and its `total` can never disagree.
- **404-over-403 for invisible resources.** Prevents leaking the existence of
  rows a caller may not see.
- **Hand-rolled ordered migrations.** A tiny runner applies `migrations/*.sql` in
  lexical order inside per-file transactions, recording applied files in
  `schema_migrations`. The runner resolves `migrations/` by walking up from its
  own location so source, compiled, and Docker layouts all work.
- **Notification seam.** The task service persists notifications through an
  injected emitter (default no-op persist; socket-backed emitter swapped in at
  startup), so the task module is testable without the socket layer and the
  socket emit stays strictly best-effort after commit.
- **Mock LLM default.** The whole stack runs offline and deterministically;
  Ollama is opt-in via one env var.

## What I'd do next

- Add cursor (keyset) pagination for `GET /tasks` to avoid `OFFSET` cost on deep
  pages at scale.
- Add an email-delivery channel for notifications alongside the socket + REST
  fallback.
- Add rate limiting on `/auth/*` and `/ai/*`.
- Expand attachment storage to a pluggable backend (e.g. S3) behind the current
  disk interface.

## Continuous integration

`.github/workflows/ci.yml` runs on push/PR on `ubuntu-latest` with a
`postgres:15` service (same credentials as compose, health-checked):
`npm ci` → `npm run build` → `npm run migrate` → `npm test` (with
`LLM_PROVIDER=mock`), injecting `DATABASE_URL`/`TEST_DATABASE_URL` and a CI
`JWT_SECRET` as job env.

## Project layout

```
src/
  config/        env schema (zod)
  db/            pg pool + migration runner
  middleware/    requestId, auth, validate, error, notFound
  modules/       auth, users, projects, tasks, comments, attachments, notifications, ai
  realtime/      socket.io server (handshake auth, rooms, emit)
  errors/        AppError
  utils/         logger
migrations/      ordered *.sql applied by the runner
scripts/         seed.ts
test/            helpers/db.ts + *.test.ts
```
