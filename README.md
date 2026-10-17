# Task Manager Backend

A task tracking and team-collaboration REST API. Users register and
authenticate, organize work into projects with members, create and assign
tasks, collaborate through comments and file attachments, receive real-time
notifications on task assignment/update, and optionally generate task
descriptions through a pluggable LLM client.

> **Submission note:** the repository submitted for review **must be public**.

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

## Environment variables

All variables are listed in [`.env.example`](./.env.example). `.env` is
gitignored.

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

The seed script truncates the domain tables first, so it is safe to re-run; it
never writes attachment files to disk.

## API overview

Base path has no version prefix. Every endpoint except `GET /health` and
`POST /auth/*` requires `Authorization: Bearer <jwt>`. Every request carries an
`X-Request-Id` (reused if a valid UUID is supplied, else generated) echoed in
the response and in every error body. List endpoints accept `limit` (1–100,
default 20) and `offset` (≥0) and return `{ data, pagination: { limit, offset, total } }`.

| method | path | auth | purpose |
|---|---|---|---|
| GET | `/health` | none | liveness + DB check |
| POST | `/auth/register` | none | create account |
| POST | `/auth/login` | none | obtain a JWT |
| POST | `/auth/logout` | JWT | invalidate the current token (blocklist) |
| GET | `/users/me` | JWT | current profile |
| PATCH | `/users/me` | JWT | update name / email / password |
| POST | `/projects` | JWT | create a project (caller becomes owner) |
| GET | `/projects` | JWT | list projects the caller owns/belongs to |
| GET | `/projects/:id` | JWT (member) | project + members |
| POST | `/projects/:id/members` | JWT (owner) | add a member (by `user_id` **or** `email`) |
| POST | `/tasks` | JWT | create a task |
| GET | `/tasks` | JWT | list/filter/sort/search visible tasks |
| GET | `/tasks/:id` | JWT | read a visible task |
| PATCH | `/tasks/:id` | JWT | update / assign / complete a task |
| DELETE | `/tasks/:id` | JWT | delete (creator or project owner) |
| POST | `/tasks/:id/comments` | JWT | add a comment |
| GET | `/tasks/:id/comments` | JWT | list comments |
| POST | `/tasks/:id/attachments` | JWT | upload a file (`multipart/form-data`, field `file`) |
| GET | `/tasks/:id/attachments` | JWT | list attachment metadata |
| GET | `/attachments/:id/download` | JWT | download a file |
| GET | `/notifications` | JWT | list notifications (`read` filter) |
| PATCH | `/notifications/:id` | JWT | mark one read (`{ "read": true }`) |
| POST | `/notifications/read-all` | JWT | mark all read |
| POST | `/ai/task-description` | JWT | generate a task description |

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

To avoid leaking the existence of resources a caller cannot see, authorization
failures on an invisible resource return **404**; **403** is used only when the
caller can see the resource but lacks permission for the specific action.

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
(paginated, newest first); `PATCH /notifications/:id` with `{ "read": true }`
and `POST /notifications/read-all` manage read state.

## AI task-description generation

`POST /ai/task-description` with `{ "input": "...", "title"?: "..." }` returns
`{ "description": "..." }`. User input is treated strictly as data framed in a
fixed trusted template; the AI module has no database or service access
(structural prompt-safety boundary).

Provider is selected by `LLM_PROVIDER`:

- `mock` (default) — deterministic, offline, no network. Used by tests, Docker, and CI.
- `ollama` — POSTs to `${OLLAMA_URL}/api/generate` with `OLLAMA_MODEL`. On an
  unreachable provider or timeout the endpoint returns `502 AI_UNAVAILABLE`.

Switch providers by setting the env var (e.g. `LLM_PROVIDER=ollama`).

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
