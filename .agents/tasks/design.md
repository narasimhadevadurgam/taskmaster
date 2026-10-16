# Task Manager Backend — Technical Design

## Overview

This document specifies the technical design for a task tracking and collaboration backend. The system lets users register and authenticate, organize work into projects with members, create and assign tasks, collaborate via comments and file attachments, receive real-time notifications on task assignment/update, and optionally generate task descriptions through a pluggable LLM client. It is a REST API written in TypeScript on Node.js/Express backed by PostgreSQL, with the canonical run path being `docker compose up` (Postgres + API with migrations applied on startup) and a GitHub Actions pipeline that runs migrations and tests against a real Postgres service.

The design is intentionally concrete: it fixes the schema, every endpoint's contract, the authorization rules per resource, the migration and test approach, the real-time transport, the AI client boundary, and the module layout, so implementation requires no further architectural decisions.

## Technology Stack (locked)

- **Runtime:** Node.js latest LTS (20.x), ES modules.
- **Language:** TypeScript in `strict` mode.
- **Web framework:** Express.js 4.
- **Database:** PostgreSQL 15+ accessed through the `pg` driver using plain parameterized SQL wrapped in a thin query helper (`src/db/pool.ts`). No ORM. Knex is permitted only as a query builder if preferred, but the reference design uses `pg` + hand-written parameterized SQL for clarity.
- **Migrations:** plain ordered SQL files in `migrations/` applied by a small custom runner (`src/db/migrate.ts`) that tracks applied files in a `schema_migrations` table. Builds the whole schema from an empty DB.
- **Auth:** JWT (`jsonwebtoken`) for sessions; `bcrypt` for password hashing (store hash only). Server-side token blocklist table for real logout invalidation.
- **Validation:** `zod` on every request body/params/query; a central middleware converts zod errors into the uniform 400 error shape.
- **File uploads:** `multer` to local disk under a gitignored `uploads/` dir (configurable `UPLOAD_DIR`), size-capped (`MAX_UPLOAD_BYTES`, default 10 MB), with metadata persisted in DB.
- **Real-time:** `socket.io` **v4** (pinned `^4.7`; chosen over raw `ws` and SSE — reasoning below). v4 handshake auth via `socket.handshake.auth.token` is the behavior relied on.
- **AI:** `LlmClient` interface with a deterministic Mock impl (default) and an Ollama HTTP impl.
- **Testing:** **Vitest** **v1** (pinned `^1.x`; chosen over Jest — reasoning below) against a real Postgres. Serial execution is configured in `vitest.config.ts` (not via ad-hoc CLI flags) — see Test Strategy.
- **CI:** GitHub Actions with a `postgres:15` service.
- **Containers:** `Dockerfile` (multi-stage) + `docker-compose.yml`.
- **Cross-platform scripts:** all npm scripts are Node-based and use `cross-env` for env vars; no bash-only scripts, since local dev is Windows.

## Project / Module Layout

```
task-manager/
  src/
    index.ts                 # process entry: load+validate env, run migrations (compose), start http+socket server
    app.ts                   # buildApp(): Express app wiring middleware + routers (exported for tests)
    server.ts                # createServer(): wraps app + socket.io, exposes start/stop for tests
    config/
      env.ts                 # zod-validated env schema -> typed config object
    db/
      pool.ts                # pg Pool + query<T>() helper + withTransaction()
      migrate.ts             # migration runner (apply pending migrations)
    middleware/
      requestId.ts           # assign/propagate X-Request-Id
      auth.ts                # verify JWT, check blocklist, attach req.user
      error.ts               # central error handler -> uniform JSON error shape
      validate.ts            # validate(schema, 'body'|'params'|'query') factory
      notFound.ts            # 404 fallback -> uniform error shape
    modules/
      auth/                  # routes, service, schemas (register/login/logout)
      users/                 # routes, service, schemas (me, patch me)
      projects/              # routes, service, schemas (create, add members)
      tasks/                 # routes, service, schemas (CRUD, list/filter, assign)
      comments/              # routes nested under tasks
      attachments/           # routes nested under tasks + download
      notifications/         # routes (list, mark-read) + emitter
      ai/                    # LlmClient interface + Mock + Ollama + generate-description route
    realtime/
      socket.ts              # socket.io server, JWT handshake auth, user rooms, emit helpers
    errors/
      AppError.ts            # typed error class with code + httpStatus
    utils/
      logger.ts             # structured logger carrying request_id
  migrations/
    0001_init.sql            # all tables + indexes + enums
  scripts/
    seed.ts                  # seed ~20 users, ~5 projects, ~200 tasks, comments
  test/
    helpers/db.ts            # per-test truncation reset, test app factory
    *.test.ts
  .github/workflows/ci.yml
  Dockerfile
  docker-compose.yml
  .env.example
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
```

Each module owns three files: `*.routes.ts` (Express router + validation wiring), `*.service.ts` (business logic + SQL, the only layer touching the DB pool), and `*.schemas.ts` (zod schemas + inferred types). Routers never embed SQL; services never read `req`/`res`. This keeps services unit-testable and routes thin.

## Data Model / ER Overview

All tables live in the default `public` schema. IDs are `BIGINT GENERATED ALWAYS AS IDENTITY` primary keys unless noted. Timestamps are `TIMESTAMPTZ DEFAULT now()`. Foreign keys use `ON DELETE` rules documented per table.

### BIGINT / id serialization policy (decided)

By default `node-postgres` returns `int8`/`BIGINT` columns as JavaScript **strings** to avoid precision loss beyond `Number.MAX_SAFE_INTEGER`. The two viable policies are (a) treat ids as strings end-to-end, or (b) register a type parser so `int8` parses to a JS `number`. **This design chooses (b): the number contract.** In `src/db/pool.ts`, before creating the pool, the code registers a global parser:

```ts
import pg from 'pg';
// OID 20 = int8/BIGINT. Parse to number; identity PKs and COUNT(*) stay well below 2^53.
pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : parseInt(v, 10)));
```

Consequences, which the rest of the design relies on:
- Every id in a response body (`user.id`, `task.id`, `assignee_id`, `project_id`, `user_id`, etc.) is a JS **number**, and the request contract documents ids as numbers.
- `pagination.total` comes from `COUNT(*)` (also `int8`); with the parser installed it is a number — no separate cast needed.
- Request-body / query id validators (`z.coerce.number().int().positive()`) produce numbers, so `assignee=me` resolution and all `===` id comparisons (e.g. actor-skip in notifications) are number-vs-number and behave correctly.
- **Precision ceiling, accepted:** identity sequences and row counts for this application will not exceed `2^53 - 1`, so parsing to `number` is safe. This assumption is documented here and in `db/pool.ts`.

### Enums
```sql
CREATE TYPE task_status   AS ENUM ('open','in_progress','completed');
CREATE TYPE task_priority AS ENUM ('low','medium','high');
CREATE TYPE project_role  AS ENUM ('owner','member');
```

### Tables

**users**
| column | type | notes |
|---|---|---|
| id | BIGINT identity PK | |
| name | TEXT NOT NULL | |
| email | CITEXT NOT NULL | unique (case-insensitive) |
| password_hash | TEXT NOT NULL | bcrypt hash only |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

`CREATE UNIQUE INDEX users_email_key ON users (email);` (CITEXT gives case-insensitive uniqueness; migration enables the `citext` extension. If `citext` is undesirable, store `email` lower-cased TEXT with a unique index and normalize in the service — reference design uses `citext`.)

**token_blocklist** — invalidated JWTs for logout
| column | type | notes |
|---|---|---|
| jti | UUID PK | JWT ID claim |
| user_id | BIGINT FK -> users(id) ON DELETE CASCADE | |
| expires_at | TIMESTAMPTZ NOT NULL | row prunable after expiry |
| created_at | TIMESTAMPTZ | |

Index: `token_blocklist_expires_at_idx` on `(expires_at)` for pruning.

**projects**
| column | type | notes |
|---|---|---|
| id | BIGINT identity PK | |
| name | TEXT NOT NULL | |
| description | TEXT | nullable |
| owner_id | BIGINT FK -> users(id) ON DELETE RESTRICT | |
| created_at | TIMESTAMPTZ | |

**project_members** — M:N users↔projects
| column | type | notes |
|---|---|---|
| project_id | BIGINT FK -> projects(id) ON DELETE CASCADE | |
| user_id | BIGINT FK -> users(id) ON DELETE CASCADE | |
| role | project_role NOT NULL DEFAULT 'member' | |
| joined_at | TIMESTAMPTZ | |

PK is composite `(project_id, user_id)`. Indexes: `project_members_user_id_idx` on `(user_id)`, `project_members_project_id_idx` on `(project_id)`.

**tasks**
| column | type | notes |
|---|---|---|
| id | BIGINT identity PK | |
| title | TEXT NOT NULL | |
| description | TEXT | nullable |
| status | task_status NOT NULL DEFAULT 'open' | |
| priority | task_priority | nullable (optional field) |
| due_date | TIMESTAMPTZ | nullable |
| creator_id | BIGINT FK -> users(id) ON DELETE RESTRICT | |
| assignee_id | BIGINT FK -> users(id) ON DELETE SET NULL | nullable |
| project_id | BIGINT FK -> projects(id) ON DELETE SET NULL | nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | maintained by service on PATCH |

Indexes: `tasks_assignee_id_idx`, `tasks_project_id_idx`, `tasks_status_idx`, `tasks_creator_id_idx`.

**comments**
| column | type | notes |
|---|---|---|
| id | BIGINT identity PK | |
| task_id | BIGINT FK -> tasks(id) ON DELETE CASCADE | |
| author_id | BIGINT FK -> users(id) ON DELETE RESTRICT | |
| body | TEXT NOT NULL | |
| created_at | TIMESTAMPTZ | |

Index: `comments_task_id_idx` on `(task_id)`.

**attachments**
| column | type | notes |
|---|---|---|
| id | BIGINT identity PK | |
| task_id | BIGINT FK -> tasks(id) ON DELETE CASCADE | |
| uploader_id | BIGINT FK -> users(id) ON DELETE RESTRICT | |
| filename | TEXT NOT NULL | original client filename (sanitized for display only) |
| mime | TEXT NOT NULL | |
| size | BIGINT NOT NULL | bytes |
| path | TEXT NOT NULL | server-side relative path under UPLOAD_DIR, random name |
| created_at | TIMESTAMPTZ | |

Index: `attachments_task_id_idx` on `(task_id)`.

**notifications**
| column | type | notes |
|---|---|---|
| id | BIGINT identity PK | |
| user_id | BIGINT FK -> users(id) ON DELETE CASCADE | recipient |
| type | TEXT NOT NULL | e.g. `task_assigned`, `task_updated` |
| payload | JSONB NOT NULL | denormalized task snapshot |
| read | BOOLEAN NOT NULL DEFAULT false | |
| created_at | TIMESTAMPTZ | |

Index: `notifications_user_read_idx` on `(user_id, read)`.

**schema_migrations** — created by the runner
| column | type | notes |
|---|---|---|
| filename | TEXT PK | applied migration filename |
| applied_at | TIMESTAMPTZ | |

> **On `updated_at`:** only `users` and `tasks` carry an `updated_at` column because they are the only resources mutated after creation (profile edits; task PATCH). `projects`, `project_members`, `comments`, `attachments`, and `notifications` are create-only in this design (notifications flip a single `read` boolean, which is not treated as a general mutation worth timestamping), so they intentionally have no `updated_at`.

### Relationships (summary)
- A user owns many projects and belongs to many projects via `project_members`.
- A project has many tasks (optional link — tasks may be project-less).
- A task has one creator, an optional assignee, many comments, many attachments.
- A user has many notifications.

## Migration / Runner Approach

Migrations are plain `.sql` files named with a zero-padded ordinal prefix (`0001_init.sql`, `0002_*.sql`, …). The runner (`src/db/migrate.ts`):

1. Ensures `schema_migrations` exists (`CREATE TABLE IF NOT EXISTS`).
2. Reads `migrations/*.sql` sorted lexicographically.
3. For each file not present in `schema_migrations`, runs it **inside a single transaction** together with the insert into `schema_migrations`, so a file either fully applies or rolls back.
4. Logs each applied file; exits non-zero on failure.

The runner is invoked three ways: `npm run migrate` (CLI), on container startup (compose entrypoint runs migrate then starts the server), and from the test DB helper. The initial design ships a single `0001_init.sql` creating the `citext` extension, all enums, all tables, and all indexes above. One migration is sufficient for the first implementation; later schema changes add new ordinal files and are never edited in place once committed.

## REST API

### Conventions
- Base path: no version prefix for v1 (documented in README); JSON request/response bodies.
- Every non-`/auth/*`, non-`/health` endpoint requires `Authorization: Bearer <jwt>`.
- Every request gets an `X-Request-Id` (incoming header reused if present and well-formed, else a generated UUID); echoed in the response header and in every error body.
- Pagination: `limit` (1–100, default 20) and `offset` (>=0, default 0) query params; list responses return `{ data: [...], pagination: { limit, offset, total } }` where `total` comes from a `COUNT(*)` over the same filter.
- **Uniform error shape** (all errors, all endpoints):
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "human readable", "request_id": "uuid" } }
  ```
  `details` (array) is optionally added for validation errors listing field paths.

### Error codes → HTTP status
| code | status | meaning |
|---|---|---|
| VALIDATION_ERROR | 400 | body/params/query failed zod validation |
| UNAUTHENTICATED | 401 | missing/invalid/blocklisted token |
| FORBIDDEN | 403 | authenticated but not permitted for resource |
| NOT_FOUND | 404 | resource absent OR hidden from this user (see authz note) |
| CONFLICT | 409 | unique violation (e.g. duplicate email), duplicate member |
| PAYLOAD_TOO_LARGE | 413 | upload exceeds MAX_UPLOAD_BYTES |
| UNSUPPORTED_MEDIA_TYPE | 415 | non-multipart on upload endpoint |
| AI_UNAVAILABLE | 502 | upstream LLM provider (Ollama) unreachable or timed out |
| SERVICE_UNAVAILABLE | 503 | dependency down (used only by `GET /health` DB check) |
| INTERNAL | 500 | unexpected; message generic, details logged with request_id |

To avoid leaking existence of resources a user cannot see, authorization failures on a resource the user has no visibility into return **404 NOT_FOUND** rather than 403; 403 is used only when the user can see the resource but lacks permission for the specific action (documented per endpoint).

### Endpoint catalog

Legend — Auth: `none` or `JWT`. Response is the success body shape; all errors use the uniform shape.

**Health**
- `GET /health` — Auth none. Response 200 `{ "status": "ok" }`. Also runs a cheap `SELECT 1`; returns 503 `{ error: { code: "SERVICE_UNAVAILABLE", message, request_id } }` (uniform error shape) if the DB is unreachable.

**Auth**
- `POST /auth/register` — Auth none. Body `{ name: string(1..200), email: email, password: string(8..200) }`. Hashes password with bcrypt (cost 12), inserts user. Response 201 `{ user: { id, name, email, created_at, updated_at } }` — `updated_at` is set to `now()` on insert and included so the `user` payload shape matches `GET /users/me` (a client can map `user` to a single type). Errors: VALIDATION_ERROR; CONFLICT if email exists (caught from unique violation `23505`).
- `POST /auth/login` — Auth none. Body `{ email, password }`. Verifies bcrypt. Response 200 `{ token: string, user: {...} }`. **The login handler generates a fresh v4 UUID `jti`** (via `crypto.randomUUID()`) and signs claims `{ sub: userId, jti, iat, exp }` with `JWT_SECRET`, expiry e.g. 24h. The `jti` is what logout later inserts into `token_blocklist` (whose PK is `jti UUID`). Errors: VALIDATION_ERROR; UNAUTHENTICATED on bad credentials (generic message, no user enumeration).
- `POST /auth/logout` — Auth JWT. Inserts the current token's `jti` + `exp` into `token_blocklist`. The JWT `exp` claim is **epoch seconds** (a number), while `token_blocklist.expires_at` is `TIMESTAMPTZ`, so the insert converts explicitly with `to_timestamp($3)`:
  ```sql
  INSERT INTO token_blocklist (jti, user_id, expires_at)
  VALUES ($1, $2, to_timestamp($3))   -- $1 = jti (uuid), $2 = req.user.id, $3 = decoded exp (seconds)
  ON CONFLICT (jti) DO NOTHING;
  ```
  Binding the raw `exp` number into the `TIMESTAMPTZ` column without `to_timestamp` would raise a type error, so the conversion is part of the contract. Because logout runs under the auth middleware, it is only reachable with a still-valid (unexpired) token — an expired token 401s at the middleware before reaching the handler — so the blocklist never needs to store an already-expired `exp`, and the expiry-based prune (see Edge Cases) is the only cleanup required. Response 200 `{ "status": "logged_out" }`. Idempotent (duplicate jti insert ignored via `ON CONFLICT DO NOTHING`).

**Users**

**Canonical `user` response object** (used by `POST /auth/register`, `POST /auth/login`, `GET /users/me`, `PATCH /users/me`):
```
user: {
  id,          // number
  name,        // string
  email,       // string
  created_at,  // ISO-8601 timestamp string
  updated_at   // ISO-8601 timestamp string
}
```
`password_hash` is **never** present in any response body (nor logged).

- `GET /users/me` — Auth JWT. Response 200 `{ user: { id, name, email, created_at, updated_at } }`.
- `PATCH /users/me` — Auth JWT. Body `{ name?: string, email?: email, password?: string(8..200) }` (at least one). Updates provided fields, re-hashes password if present, bumps `updated_at`. Response 200 `{ user: {...} }`. Errors: VALIDATION_ERROR; CONFLICT on email collision.

**Projects**
- `POST /projects` — Auth JWT. Body `{ name: string(1..200), description?: string(0..2000) }`. Creates project with `owner_id = req.user.id` and inserts a `project_members` row `(project, user, 'owner')` in the same transaction. Response 201 `{ project: {...} }`.
- `POST /projects/:id/members` — Auth JWT (**owner only**, else 403). Body `{ user_id?: number, email?: string }`, **exactly one** of `user_id`/`email` present. Because this cross-field constraint is not expressible by a plain `z.object`, the schema is `z.object({ user_id: z.coerce.number().int().positive().optional(), email: z.string().email().optional() }).refine(d => (d.user_id == null) !== (d.email == null), 'provide exactly one of user_id or email')`; both-or-neither → 400 VALIDATION_ERROR. Resolves the user, inserts membership `role='member'`. Response 201 `{ member: { project_id, user_id, role, joined_at } }`. Errors: NOT_FOUND if project not visible to caller or target user missing; FORBIDDEN if caller is a member but not owner; CONFLICT if already a member.
- `GET /projects` — Auth JWT. Lists projects the caller owns or belongs to (via `project_members`), paginated. Deterministic order `ORDER BY created_at DESC, id DESC` (required for stable pagination). Each row shape: `{ id, name, description, owner_id, created_at, role }` where `role` is the caller's own role in that project (`owner` or `member`, from the caller's `project_members` row). `pagination.total` is `COUNT(*)` over the same membership predicate. (Included for usability; satisfies "view my projects".)
- `GET /projects/:id` — Auth JWT, member-only (else 404). Response 200 `{ project, members: [...] }` where `project` is `{ id, name, description, owner_id, created_at }` and each member object is `{ user_id, name, email, role, joined_at }` (joined from `project_members` to `users`). Members are ordered `role` (owner first), then `joined_at ASC, user_id ASC` for determinism.

**Tasks**

**Canonical `task` response object (used identically by every task endpoint and inside `GET /tasks` list items).** All four task endpoints (`POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`) and each element of the `GET /tasks` `data` array return this exact shape and nothing else — no embedded joined names:
```
task: {
  id,            // number (BIGINT via the OID-20 parser)
  title,         // string
  description,   // string | null
  status,        // 'open' | 'in_progress' | 'completed'
  priority,      // 'low' | 'medium' | 'high' | null
  due_date,      // ISO-8601 datetime string | null
  creator_id,    // number
  assignee_id,   // number | null
  project_id,    // number | null
  created_at,    // ISO-8601 timestamp string
  updated_at     // ISO-8601 timestamp string
}
```
Ids are numbers per the OID-20 type-parser policy; `due_date`, `created_at`, and `updated_at` serialize as ISO-8601 strings (`Date#toJSON`). `description`, `priority`, `assignee_id`, and `project_id` are nullable.

- `POST /tasks` — Auth JWT. Body `{ title: string(1..300), description?: string(0..10000), status?: task_status, priority?: task_priority, due_date?: ISO datetime, assignee_id?: number, project_id?: number }`. `creator_id` is always `req.user.id` (never from client). If `project_id` given, caller must be a member (else 404). If `assignee_id` given with a `project_id`, assignee must be a member of that project (else 400 VALIDATION_ERROR with a clear message). If `assignee_id` given **without** a `project_id`, the service verifies the user exists; a non-existent user → 400 VALIDATION_ERROR. Response 201 `{ task: {...} }`.
- `GET /tasks/:id` — Auth JWT, visibility rule below. Response 200 `{ task: {...} }`.
- `PATCH /tasks/:id` — Auth JWT, edit rule below. Body any subset of `{ title, description?: string(0..10000), status, priority, due_date, assignee_id, project_id }`. Marking completed = `status:'completed'`. Setting a non-null `project_id` additionally requires the caller to be a member of the target project (else 404 — see authz rules). Assignment = setting `assignee_id`; the project-membership/existence rule is re-validated against the task's effective (post-update) project. Bumps `updated_at`. On assignee change or any field update, emits notifications per the precise rule in Real-time. Response 200 `{ task: {...} }`.
- `DELETE /tasks/:id` — Auth JWT, delete rule below. Response 204. Cascades delete comments + attachments rows; attachment files are best-effort unlinked from disk (failure logged, not fatal).
- `GET /tasks` — Auth JWT. Query: `status` (enum), `assignee` (`me` or numeric user id), `project` (numeric id), `sort` (`due_date|created_at|priority`, default `created_at`), `order` (`asc|desc`, default `desc`), `q` (search string, ILIKE on title OR description), `limit`, `offset`. Results restricted to tasks visible to the caller (visibility rule). `priority` sort relies on **native enum ordering**: the `task_priority` enum is declared `('low','medium','high')` and Postgres orders enum values by declaration order, so a `priority` sort yields high→medium→low (for `order=desc`) with no CASE expression.

  **Authoritative ORDER BY (single form, reused byte-identical by the paginated `SELECT` and any re-query across pages):**
  ```
  ORDER BY <sortcol> <order> NULLS LAST, id <order>
  ```
  where `<sortcol>` ∈ {`created_at` (default), `due_date`, `priority`} and `<order>` ∈ {`asc`, `desc`} (default `desc`). The rule is uniform for every sort column and both orders: **always append `NULLS LAST`** (regardless of `order`, so `due_date ASC` places NULL due dates last rather than taking SQL's default `NULLS FIRST`), then **`, id <order>` as the final, total tie-break** following the chosen `order` direction. Because `id` is unique, this clause is a total order, making pagination stable; because the data query and `COUNT(*)`/next-page queries share this one form verbatim, there is no ORDER BY drift. Concretely: default `ORDER BY created_at DESC NULLS LAST, id DESC`; `sort=due_date&order=asc` → `ORDER BY due_date ASC NULLS LAST, id ASC`; `sort=priority&order=desc` → `ORDER BY priority DESC NULLS LAST, id DESC`. Response 200 paginated.

  **Visibility + filter SQL (applied identically to the data query and the `COUNT(*)` for `pagination.total`).** The base visibility predicate is non-negotiable and always present; the optional filters are `AND`-ed onto it:
  ```sql
  WHERE (t.creator_id = $me
         OR t.assignee_id = $me
         OR t.project_id IN (SELECT project_id FROM project_members WHERE user_id = $me))
    -- optional, each added only when the corresponding query param is present:
    AND ($status  IS NULL OR t.status = $status)
    AND ($project IS NULL OR t.project_id = $project)
    AND ($assignee IS NULL OR t.assignee_id = $assignee)   -- assignee=me resolves $assignee := $me
    AND ($q IS NULL OR t.title ILIKE '%'||$q||'%' ESCAPE '\' OR t.description ILIKE '%'||$q||'%' ESCAPE '\')
  ```
  **`q` is a literal substring, not a LIKE pattern.** Because `%`, `_`, and `\` are LIKE metacharacters, the service escapes them in the user string before binding `$q`, and each `ILIKE` declares an explicit escape character:
  ```ts
  // escape LIKE metacharacters so q behaves as a literal substring; bind likeQ as $q
  const likeQ = q.replace(/([\\%_])/g, '\\$1');
  // SQL: ... ILIKE '%'||$q||'%' ESCAPE '\' ...  (bind $q = likeQ)
  ```
  Without this, a search for `50%` or `a_b` would silently match far more rows than intended (wildcard behavior), breaking the "search tasks by title/description" story. The predicate stays parameterized, so there is no injection risk; the escaping only fixes semantic correctness.

  The service builds this predicate once and reuses it verbatim for both the paginated `SELECT ... ORDER BY ... LIMIT/OFFSET` and the `SELECT COUNT(*)`; therefore `pagination.total` is the count of exactly the rows the caller is allowed to see under the active filters, and can never leak or disagree with `data`. A caller filtering by a `project` they are not a member of still only sees tasks the base predicate admits (i.e. tasks in that project where they are creator/assignee), never the whole project. **Filter-vs-authz rule:** the `status`, `assignee`, `project`, and `q` filters are pure `AND` narrowings applied on top of the base visibility predicate (which is ANDed first), so they only narrow the already-authorized set and can never widen visibility; a filter value the caller cannot otherwise see simply yields fewer or zero rows and is never itself an authorization error (no extra 403/404 check is added for filter values).

**Comments** (nested under task)

**Canonical `comment` response object** (used by `POST`/`GET /tasks/:id/comments`, including each list item):
```
comment: {
  id,          // number
  task_id,     // number
  author_id,   // number
  body,        // string
  created_at   // ISO-8601 timestamp string
}
```
- `POST /tasks/:id/comments` — Auth JWT, task-visibility required. Body `{ body: string(1..5000) }`. `author_id = req.user.id`. Response 201 `{ comment: {...} }`.
- `GET /tasks/:id/comments` — Auth JWT, task-visibility. Paginated, ordered `created_at ASC, id ASC`. Response 200 paginated.

**Attachments**

**Canonical `attachment` metadata object** (used by `POST`/`GET /tasks/:id/attachments`, including each list item) — the server-side `path` column is **never** serialized:
```
attachment: {
  id,          // number
  task_id,     // number
  uploader_id, // number
  filename,    // string (original client filename, sanitized for display)
  mime_type,   // string   (serialized from the DB `mime` column)
  size_bytes,  // number   (serialized from the DB `size` column, bytes)
  created_at   // ISO-8601 timestamp string
}
```
The response field names (`mime_type`, `size_bytes`) are the public contract; they map to the `mime` and `size` DB columns respectively. The `path` column is internal and is never present in any response body.

- `POST /tasks/:id/attachments` — Auth JWT, task-visibility. `multipart/form-data` single field `file`. multer stores to `UPLOAD_DIR` with a random filename; limit `MAX_UPLOAD_BYTES`. Persists metadata row. Response 201 `{ attachment: {...} }` (the canonical shape above; never returns server `path`). Errors (decision is Content-Type-driven, so the clauses do not overlap): **415 UNSUPPORTED_MEDIA_TYPE** when the request Content-Type is not `multipart/form-data` (detected before multer); **413 PAYLOAD_TOO_LARGE** when multer rejects on size; **400 VALIDATION_ERROR** when the Content-Type is multipart but no `file` field is present.
- `GET /tasks/:id/attachments` — Auth JWT, task-visibility. Paginated metadata list.
- `GET /attachments/:id/download` — Auth JWT. Looks up attachment, re-checks task-visibility of the attachment's task; streams the file with `Content-Type: mime` and `Content-Disposition: attachment; filename="<sanitized original>"`. Errors: NOT_FOUND if attachment or file missing or task not visible.

**Notifications**

**Canonical `notification` response object** (used by `GET /notifications` list items and `PATCH /notifications/:id`):
```
notification: {
  id,          // number
  user_id,     // number (recipient)
  type,        // string: 'task_assigned' | 'task_updated'
  payload,     // JSON object, fixed keys below
  read,        // boolean
  created_at   // ISO-8601 timestamp string
}
```
The `payload` JSONB is a denormalized task snapshot with these fixed keys so the real-time socket event and this REST fallback carry the identical contract:
```
payload: {
  task_id,     // number
  title,       // string
  status,      // task_status
  project_id,  // number | null
  actor_id     // number (the user who caused the notification)
}
```

- `GET /notifications` — Auth JWT. Query `read` (optional bool filter), `limit`, `offset`. Lists caller's notifications newest first (`ORDER BY created_at DESC, id DESC`). Response 200 paginated.
- `PATCH /notifications/:id` — Auth JWT, owner-only. Body `{ read: true }` validated as `z.object({ read: z.literal(true) })` (literal `true`, never `z.boolean()`, so a `false` is a VALIDATION_ERROR rather than a silent no-op). Marks read. Response 200 `{ notification: {...} }`. NOT_FOUND if not caller's.
- `POST /notifications/read-all` — Auth JWT. Marks all caller's notifications read. Response 200 `{ updated: n }`.

**AI**
- `POST /ai/task-description` — Auth JWT. Body `{ input: string(1..1000), title?: string }`. Calls `LlmClient.complete(prompt)` built from a fixed system template plus the user input treated strictly as data. Returns 200 `{ description: string }`. The route performs no DB writes. Errors: VALIDATION_ERROR; **502 with `error.code = "AI_UNAVAILABLE"`** if the provider (Ollama) is unreachable/times out (recoverable from caller's view — they can retry or type manually). With the default mock provider this never fails.

## Authorization Rules (per resource)

Enforced in the service layer, which is the single owner of authorization invariants because it is the only layer with DB access needed to resolve membership. The route layer only guarantees authentication (valid, non-blocklisted token).

**Auth middleware (`middleware/auth.ts`) token checks, in order** — any failure returns **401 UNAUTHENTICATED** (generic message, logged at debug):
1. Extract `Authorization: Bearer <jwt>`; missing/malformed header → 401.
2. `jwt.verify(token, JWT_SECRET)`; bad signature / expired / malformed → 401.
3. Read the verified `jti` claim; if it is **missing or not a syntactically valid UUID**, reject with 401 **before** querying the blocklist (the `token_blocklist.jti` column is UUID-typed, so passing a non-UUID into the lookup would otherwise raise a DB error — this guard keeps the lookup total). A `z.string().uuid()` check is used; note this accepts any UUID version, which is exactly what is needed here — the guard's only job is to keep the UUID-typed lookup total, not to enforce a specific version. (The `jti` is minted by our own login handler via `crypto.randomUUID()`, which already produces v4, so no version check is required.)
4. `SELECT 1 FROM token_blocklist WHERE jti = $1`; a hit → 401 (token was logged out).
5. Load the user by `sub`; if the user no longer exists → 401. On success attach `req.user = { id, name, email }` and continue. Client-supplied ids are never trusted for ownership; `creator_id`, `author_id`, `uploader_id`, and notification `user_id` always come from `req.user.id`.

**Task visibility** (read a task / its comments / its attachments): the caller must be the task creator, OR the task assignee, OR (if the task has a `project_id`) a member of that project. Otherwise 404.

**Task edit** (`PATCH /tasks/:id`): creator, assignee, or a member of the task's **current** project may edit. Rationale: collaboration within a project is the point; project membership grants edit. If stricter control is wanted later it is a schema-free policy change in one service function.

**Moving a task into/within a project** (`PATCH` that sets or changes `project_id` to a non-null value): the caller must additionally be a member of the **target** project, mirroring the create-time rule. If the caller is not a member of the target project → **404 NOT_FOUND** (the target project is treated as not visible to the caller, consistent with the no-existence-leak policy). This prevents an editor from injecting a task into an arbitrary team's project (which would otherwise grant that project's members visibility of the task). Setting `project_id` to `null` (detaching) requires only the normal task-edit permission. After the project change is authorized, the assignment invariant is re-validated against the new project in the same transaction.

**Task delete** (`DELETE /tasks/:id`): creator, or the owner of the task's project. Assignees and ordinary members cannot delete. FORBIDDEN (403) if the caller can see the task but is not creator/project-owner.

**Project membership add** (`POST /projects/:id/members`): project owner only.

**Comment create**: any user with task-visibility.

**Attachment upload / download**: any user with task-visibility on the attachment's task.

**Assignment invariant**: when a task has a `project_id`, its `assignee_id` must reference a current member of that project. Enforced in the task service on both create and update by a membership check inside the same transaction as the write, so a concurrent membership removal cannot slip through. If the assignee is not a member → **400 VALIDATION_ERROR** with a clear message. For a **project-less** task, `assignee_id` may be any existing user, but existence is still validated: the service checks the user exists (within the write transaction); a non-existent `assignee_id` → **400 VALIDATION_ERROR** (never surfaced as a raw FK violation). Defense in depth: the `assignee_id` FK would also raise `23503`, which the service maps to 400 VALIDATION_ERROR for the assignee case; but the design relies on the explicit existence check, not the FK error, as the primary path so the message is clear.

**Notification access**: a user reads/mutates only rows where `user_id = req.user.id`.

## Validation Rules (per external input)

All validation is zod schemas applied by the `validate(schema, source)` middleware before the handler runs; failures produce VALIDATION_ERROR (400) with a `details` array of `{ path, message }`.

- **email**: required where noted, `z.string().email()`, max 320. Under the chosen `CITEXT` path the uniqueness mechanism is the case-insensitive unique index — the service's lower-casing before persistence is **cosmetic normalization only** (consistent stored display form), not load-bearing for uniqueness. (If the alternative lower-cased `TEXT` column were used instead, that normalization would become the uniqueness mechanism; the reference design uses CITEXT and treats lower-casing as cosmetic.)
- **password**: required on register, min 8, max 200. Not logged, never returned.
- **name/title**: required, trimmed, length bounds (name 1–200, title 1–300).
- **description/body**: optional/required text with max bounds (task description 10 000, project description 2 000, comment body 5 000).
- **status/priority/role**: must match enum literal sets; unknown value → 400.
- **due_date**: optional, validated by `z.string().datetime()` — a **full ISO-8601 datetime is required** (e.g. `2025-01-31T23:59:00Z`); a date-only value such as `2025-01-31` is rejected with 400. This is the pinned decision (the alternative of accepting date-only and coercing to end-of-day UTC is explicitly not taken); clients must supply the time component. The value is stored as `TIMESTAMPTZ` and serialized back as an ISO-8601 string.
- **numeric ids in params**: `z.coerce.number().int().positive()`; non-numeric `:id` → 400 (not 404).
- **list query params**: `limit`/`offset` coerced ints with bounds; `assignee` either literal `me` or positive int; `sort`/`order` enum literals; `q` max 200. `q` is treated as a **literal substring, not a pattern**: the task service escapes LIKE metacharacters (`%`, `_`, `\`) before binding it into the `ILIKE ... ESCAPE '\'` filter (see GET /tasks), so searching for `50%` or `a_b` matches those characters literally.
- **file upload**: multer `limits.fileSize = MAX_UPLOAD_BYTES`; a single `file` field required. Error mapping is Content-Type-driven first, then `MulterError.code`, so the branches are mutually exclusive: a request whose Content-Type is **not** `multipart/form-data` → 415 UNSUPPORTED_MEDIA_TYPE (detected before multer runs); a `multipart/form-data` request with **no `file` field** present → 400 VALIDATION_ERROR; `LIMIT_FILE_SIZE` → 413 PAYLOAD_TOO_LARGE. Other `MulterError` codes (e.g. `LIMIT_UNEXPECTED_FILE`) → 400 VALIDATION_ERROR. The attachment route wraps the multer middleware so these map into the uniform error shape rather than multer's default handler.
- **AI input**: `input` required 1–1000 chars, `title` optional ≤300; treated as opaque data, never interpolated into SQL or executed.

Invariant ownership: field-shape validation is owned by the zod layer; cross-entity invariants (membership, ownership, uniqueness beyond the DB constraint) are owned by the service layer because they require DB state. The DB owns the last line of defense via `NOT NULL`, FK, unique, and enum constraints; the service maps constraint violations (`23505` → CONFLICT, `23503` → VALIDATION_ERROR/NOT_FOUND as appropriate) to the uniform error shape.

## Error Handling (per failure mode)

A single Express error-handling middleware (`middleware/error.ts`) is the only place that writes error responses. Services throw typed `AppError(code, httpStatus, message, details?)`; unexpected errors (anything not an `AppError`) are logged at `error` level with the `request_id` and stack, then returned as a generic 500 `INTERNAL` with no internal details in the body.

| Operation | Failure condition | Recoverable? | Caller receives | Logging |
|---|---|---|---|---|
| DB query | pool/connection error | fatal to request | 500 INTERNAL | error + request_id + stack |
| register | duplicate email (`23505`) | recoverable | 409 CONFLICT | info |
| login | bad credentials | recoverable | 401 UNAUTHENTICATED (generic) | info (no email in msg) |
| auth middleware | missing/garbled/expired JWT | recoverable | 401 UNAUTHENTICATED | debug |
| auth middleware | jti in blocklist | recoverable | 401 UNAUTHENTICATED | debug |
| any validation | zod failure | recoverable | 400 VALIDATION_ERROR + details | debug |
| task/project access | not visible | recoverable | 404 NOT_FOUND | debug |
| task delete / member add | visible but not permitted | recoverable | 403 FORBIDDEN | info |
| assignment | assignee not project member | recoverable | 400 VALIDATION_ERROR | info |
| upload | oversize | recoverable | 413 PAYLOAD_TOO_LARGE | info |
| upload | wrong content-type | recoverable | 415 UNSUPPORTED_MEDIA_TYPE | info |
| download | file row exists, disk file missing | fatal to request | 404 NOT_FOUND | error (data drift) |
| AI complete | Ollama timeout/unreachable | recoverable | 502 AI_UNAVAILABLE | warn |
| notification emit | socket emit throws / no listener | non-fatal | request still succeeds | warn; rows (one per recipient) already persisted in the txn; empty recipient set → no row |

Notification persistence and emission are decoupled: **notification rows (one per computed recipient — see the precise rule in Real-time Transport) are written inside the task service's transaction; if the computed recipient set is empty, no row is written.** The socket emit is a best-effort side effect performed after commit, once per persisted row. A failed emit never fails the task operation, and the recipient can still fetch via `GET /notifications`.

## Real-time Transport (decision)

**Chosen: `socket.io`.** Alternatives considered: raw `ws` (lowest overhead but requires hand-rolling handshake auth, rooms, reconnection, and heartbeats) and SSE (simple, one-directional, but needs a separate channel/polling for client acks and loses the clean per-user addressing we get from rooms). `socket.io` gives JWT handshake authentication, automatic reconnection, and per-user **rooms** out of the box, which maps directly onto "notify affected user(s)," at the cost of a slightly heavier client. Given we only push server→client notifications and want minimal custom plumbing, `socket.io` is the pragmatic choice.

Design (`realtime/socket.ts`):
- The socket.io server attaches to the same HTTP server as Express.
- Handshake auth middleware reads the JWT from `socket.handshake.auth.token`, verifies it, checks the blocklist, and on success joins the socket to room `user:<id>`; invalid tokens are rejected with a connect error.
- `emitNotification(userId, notification)` emits event `notification` to room `user:<id>`.
- **Notification rule for `PATCH /tasks/:id` (precise, resolves combined-change / actor-skip / empty-recipient ambiguity).** Let `actor = req.user.id`. Within the task service's update transaction, after computing the new row:
  1. **Assignment change** — if the PATCH sets `assignee_id` to a value different from the previous assignee AND the new assignee is not `actor`, write exactly **one** `task_assigned` notification row for the new assignee. (Clearing the assignee, or re-assigning to the actor, writes no `task_assigned` row. Nothing is written for the previous assignee.)
  2. **Other field changes** — if any non-`assignee_id` field actually changed (title, description, status, priority, due_date, project_id), compute the recipient set `{creator_id, current assignee_id (post-update)} \ {actor}`, drop nulls, dedupe, and write **one** `task_updated` row per remaining recipient.
  3. A PATCH that changes both the assignee and other fields therefore produces: one `task_assigned` row for the new assignee (step 1) **plus** `task_updated` rows per step 2 (the new assignee may receive both, which is intentional — assignment and the field edit are distinct events).
  4. **Empty recipient set → no row is written and nothing is emitted.** (E.g. the creator edits their own unassigned task: recipients `{creator} \ {actor}` is empty.)

  Each persisted row is emitted after commit (step below) to its recipient's room; the set of rows written and the set of emits are identical.
- README documents the connect flow: `io(URL, { auth: { token } })` then `socket.on('notification', cb)`, plus the REST fallback `GET /notifications`.

## AI Client Design & Prompt-Safety Stance

`modules/ai/LlmClient.ts` defines `interface LlmClient { complete(prompt: string): Promise<string> }`. A factory `createLlmClient(config)` returns an implementation based on `LLM_PROVIDER`:

- **MockLlmClient (default, `LLM_PROVIDER=mock`)**: deterministic, no network, no key. Produces a stable templated description from the input (e.g. a fixed-format sentence incorporating the first N words), so tests and `docker compose` run fully offline and assertions are reproducible.
- **OllamaLlmClient (`LLM_PROVIDER=ollama`)**: POSTs to `${OLLAMA_URL}/api/generate` (default `http://localhost:11434`) with `model = OLLAMA_MODEL` (default `llama3.1:8b`), `stream:false`, a bounded timeout (e.g. 20s). On non-200/timeout/connection error it throws `AppError('AI_UNAVAILABLE', 502, ...)`.

The route builds the prompt from a **fixed trusted template** that frames the user text explicitly as untrusted content to summarize/expand, never as instructions. **Prompt-safety stance:** user input is data, not control. The LLM is used only to produce text that is returned to the caller; it is given **no tools and no database write authority** — the AI module imports no DB pool and no services. Even if a user attempts prompt injection, the worst outcome is undesirable generated text in the HTTP response, with no state change. This boundary is structural (module has no DB dependency), not merely conventional.

## Config / Environment

`config/env.ts` parses `process.env` through a zod schema at startup and exits with a clear message if invalid. Variables (all documented in `.env.example`):

| var | required | default | purpose |
|---|---|---|---|
| DATABASE_URL | yes | — | Postgres connection string |
| JWT_SECRET | yes | — | HMAC secret for JWT (min length enforced) |
| PORT | no | 3000 | HTTP port |
| LLM_PROVIDER | no | `mock` | `mock` or `ollama` |
| OLLAMA_URL | no | `http://localhost:11434` | Ollama base URL |
| OLLAMA_MODEL | no | `llama3.1:8b` | Ollama model |
| UPLOAD_DIR | no | `uploads` | local upload directory |
| MAX_UPLOAD_BYTES | no | `10485760` (10 MB) | upload size cap |
| NODE_ENV | no | `development` | standard |

`.env` is gitignored; `.env.example` lists every key with safe placeholder values.

## Seed Script

`scripts/seed.ts` (run via `npm run seed`, uses the pool + bcrypt) populates a dev DB: ~20 users (shared known password hashed once and reused for speed), ~5 projects each with a subset of users as members (one owner each), ~200 tasks with varied `status`, `priority`, assignees drawn from each task's project members (respecting the assignment invariant), nullable due dates spread across past/future, and some comments scattered across tasks. Inserts are **batched** (multi-row `INSERT ... VALUES` with parameter arrays) and wrapped per-entity in a transaction to stay fast. The script is idempotent-friendly: it truncates the domain tables (`RESTART IDENTITY CASCADE`) before seeding so re-running yields a clean dataset. It does not create attachments on disk.

## Test Strategy

**Framework: Vitest** (chosen over Jest). Reasoning: native ESM + TypeScript support with zero Babel config fits the ESM/TS-strict stack cleanly, and its single-threaded/`--pool=forks --poolOptions.singleFork` mode makes serial DB tests straightforward. Jest would also work; Vitest is selected to avoid ESM/ts-jest friction.

Tests run against a **real Postgres** (the compose/CI Postgres, or a `TEST_DATABASE_URL`). Approach:

- A global setup runs the migration runner once against the test database so the schema matches production exactly.
- **Isolation via truncation**: a `test/helpers/db.ts` `resetDb()` helper runs `TRUNCATE users, projects, project_members, tasks, comments, attachments, notifications, token_blocklist RESTART IDENTITY CASCADE` in a `beforeEach`. This is chosen over per-test transaction-rollback because the app uses its own pool connections (and real commits for the assignment-invariant transactions), which a single rolled-back transaction cannot wrap cleanly; truncation keeps tests honest end-to-end.
- Tests run **serially** so they share one database without cross-test interference. This is configured once in `vitest.config.ts` as `test: { pool: 'forks', poolOptions: { forks: { singleFork: true } }, fileParallelism: false }` (the single authoritative spelling for Vitest v1 — no conflicting CLI flags). Documented in the README.
- The app is exercised through `buildApp()` with `supertest` for HTTP-level tests (register→login→task CRUD→assignment→comments→attachments→notifications→AI). Services with pure logic (prompt building, sort/filter SQL construction, authz predicates) also get focused unit tests.
- **Unit-testable without DB**: env parsing, the Mock LLM client, prompt construction, error-shape mapping, request-id middleware. **Integration (needs DB)**: everything touching the pool — auth, tasks, projects, comments, attachments, notifications persistence. Real-time emit is tested by asserting the persisted notification row plus a lightweight socket.io client connecting with a valid JWT and receiving the event.
- The AI endpoint is always tested with the Mock provider (deterministic output), so no network is required in CI.

## Docker & CI Wiring

**Dockerfile** (multi-stage): a `builder` stage installs all deps and runs `tsc` to `dist/`; a slim runtime stage copies `dist/`, `migrations/`, `package.json`, and production `node_modules`. Entry runs the migration runner then `node dist/index.js`. A non-root user owns `UPLOAD_DIR`.

**docker-compose.yml** defines two services:
- `db`: `postgres:15`, env `POSTGRES_USER=taskmgr`, `POSTGRES_PASSWORD=taskmgr`, `POSTGRES_DB=task_manager`, ports `5432:5432`, a named volume for data, and a `healthcheck` using `pg_isready`.
- `api`: built from the Dockerfile, `depends_on: db` with `condition: service_healthy`, env `DATABASE_URL=postgres://taskmgr:taskmgr@db:5432/task_manager`, `JWT_SECRET` (compose default dev value), `LLM_PROVIDER=mock`, port e.g. `3000:3000`, upload volume mounted. The api container's startup command **runs migrations before serving**, so `docker compose up` yields a ready, migrated API with a mock LLM — fully offline.

**.github/workflows/ci.yml**: on push/PR, a job on `ubuntu-latest` with a `postgres:15` **service** (same creds, health-checked), Node LTS setup with npm cache, `npm ci`, `npm run build` (tsc, catches type errors in strict mode), `npm run migrate` against the service DB, then `npm test` (`LLM_PROVIDER=mock`). `DATABASE_URL`/`TEST_DATABASE_URL` and a CI `JWT_SECRET` are injected as job env. Lint/format check step included if configured.

All npm scripts are Node/`cross-env`-based so they run identically on the Windows dev machine and Linux CI. To avoid the deprecated-`--loader` ambiguity, the design standardizes on **`tsx`** for running TypeScript directly in dev/CI and on **compiled JS** in the container: `"migrate:dev": "tsx src/db/migrate.ts"`, `"migrate": "node dist/db/migrate.js"` (used by the Docker entrypoint after `tsc`), `"seed": "tsx scripts/seed.ts"`, `"test": "cross-env LLM_PROVIDER=mock vitest run"`, `"build": "tsc"`. No script uses `node --loader`.

## Edge Cases

- **Duplicate registration** race: rely on the DB unique index; two concurrent registers → one succeeds, the other maps `23505` to 409.
- **Logout then reuse token**: blocklist check in auth middleware rejects with 401 even though the JWT signature/expiry are still valid.
- **Token expiry vs blocklist pruning**: blocklist rows carry `expires_at`; a periodic prune (or on-write cleanup) removes expired rows; correctness never depends on pruning because expired JWTs fail verification anyway.
- **Assigning across projects**: moving a task's `project_id` while it has an `assignee_id` re-validates membership against the new project in the same transaction; invalid → 400.
- **Deleting a user referenced by tasks**: FK rules — `creator_id`/`author_id`/`uploader_id` use `ON DELETE RESTRICT` (deletion blocked, surfaced as 409/validation), `assignee_id` uses `SET NULL`. Reference design does not expose user deletion as an endpoint; the constraints document the intent.
- **Project deletion** nulls tasks' `project_id` (tasks survive, become project-less) and cascades `project_members`.
- **Attachment disk/DB drift**: download of a row whose file is gone returns 404 and logs an error; task deletion unlinks files best-effort and never fails the delete on an unlink error.
- **Large/malicious filenames**: original filename stored only as metadata and sanitized for `Content-Disposition`; on-disk name is random, preventing path traversal.
- **Sort by nullable `priority`/`due_date`**: explicit `NULLS LAST` and a deterministic `id` tie-breaker so pagination is stable. `priority` uses native enum declaration-order ranking (`low`<`medium`<`high`), not a CASE expression.
- **Request-id passthrough**: a client-supplied `X-Request-Id` is reused only if it matches a safe UUID pattern, else regenerated, so it cannot be used to inject into logs.

## Acceptance Alignment

This design covers every item in the brief: secure register/login/logout (real invalidation via blocklist) and profile management; full task CRUD with filter/sort/search/pagination, completion, and membership-validated assignment; projects with M:N members and owner-gated invites; comments and multer attachments with authz-checked download; implemented real-time notifications (socket.io + persisted REST fallback); implemented pluggable AI with offline mock default and a strict no-DB prompt-safety boundary; uniform error shape with request ids; the exact tables and indexes specified; migration runner, real-Postgres test strategy, docker compose (migrate-on-start, 5432 published, taskmgr/taskmgr/task_manager), and GitHub Actions CI; cross-platform Node scripts for the Windows dev target with `docker compose up` as the canonical run path.

## Responses to Design Review (round 3)

This revision resolves every finding in round 3's `design-review.json` / `design-review.md` (verdict CHANGES_REQUESTED: 0 HIGH, 5 MEDIUM, 4 NIT). All changes are response-contract specifications — no architectural rework.

1. **MEDIUM (#1) — `GET /tasks` NULLS handling for `due_date`/all sorts under `asc`/`desc`.** Addressed. `GET /tasks` now gives a single authoritative ORDER BY template `ORDER BY <sortcol> <order> NULLS LAST, id <order>` and states the uniform rule: every sort column, both orders, **always append `NULLS LAST`** (so `due_date ASC` is `NULLS LAST`, not SQL's default `NULLS FIRST`), with worked examples for `created_at`/`due_date`/`priority`.
2. **MEDIUM (#2) — id tie-break direction unspecified; ORDER BY drift risk.** Addressed. The tie-break is pinned to follow `order` (`, id <order>`), declared the single authoritative ORDER BY form reused byte-identical by the paginated `SELECT`, `COUNT(*)`, and next-page queries, so there is no drift and pagination is stable (`id` is unique → total order).
3. **MEDIUM (#3) — task response shape undefined.** Addressed. Added the canonical `task` object `{ id, title, description, status, priority, due_date, creator_id, assignee_id, project_id, created_at, updated_at }` (ids as numbers per the OID-20 parser; `due_date`/`created_at`/`updated_at` as ISO-8601 strings; nullables marked) and required all four task endpoints and every `GET /tasks` list item to return exactly it, with no embedded joined names.
4. **MEDIUM (#4) — comment/notification/payload shapes undefined.** Addressed. Enumerated the canonical `comment` object `{ id, task_id, author_id, body, created_at }` and `notification` object `{ id, user_id, type, payload, read, created_at }`, and pinned the `payload` snapshot keys `{ task_id, title, status, project_id, actor_id }` so the socket event and REST fallback share one contract. (Also pinned the `attachment` metadata object `{ id, task_id, uploader_id, filename, mime_type, size_bytes, created_at }`, which never serializes the disk `path`, and the `user` object `{ id, name, email, created_at, updated_at }`, which never serializes `password_hash`.)
5. **MEDIUM (#5) — filter-vs-authz semantics not stated.** Addressed. Added one sentence to `GET /tasks`: the `status`/`assignee`/`project`/`q` filters are pure `AND` narrowings on top of the base visibility predicate (ANDed first) and never widen visibility; a filter value the caller cannot otherwise see yields fewer/zero rows and is never itself a 403/404.
6. **NIT (#6) — logout/blocklist expired-token note.** Addressed. `POST /auth/logout` now notes that logout is only reachable with a still-valid token (expired tokens 401 at the middleware), so the blocklist never stores an already-expired `exp` and the expiry-based prune is the only cleanup needed. No behavioral change.
7. **NIT (#7) — "exactly one of user_id | email" needs an explicit zod refine.** Addressed. `POST /projects/:id/members` now pins `z.object({ user_id, email }).refine(d => (d.user_id == null) !== (d.email == null), 'provide exactly one of user_id or email')` with both-or-neither → 400.
8. **NIT (#8) — `PATCH /notifications/:id` should use `z.literal(true)`.** Addressed. The body is validated as `z.object({ read: z.literal(true) })`, so a `false` is a VALIDATION_ERROR rather than a silent no-op.
9. **NIT (#9) — `due_date` date-only input semantics unstated.** Addressed. Pinned the decision in Validation Rules: `z.string().datetime()` requires a full ISO-8601 datetime (date-only → 400); the coerce-to-end-of-day alternative is explicitly not taken.

## Responses to Design Review (round 2)

This revision resolves every finding in the current `design-review.json` / `design-review.md` (verdict CHANGES_REQUESTED: 0 HIGH, 2 MEDIUM, 5 NIT).

1. **MEDIUM — `q` search does not escape LIKE wildcards.** Addressed. `GET /tasks` now escapes `%`, `_`, and `\` in the user string (`q.replace(/([\\%_])/g, '\\$1')`) before binding `$q`, and each `ILIKE` declares `ESCAPE '\'`. Validation Rules now state `q` is a literal substring, not a pattern. The predicate stays parameterized (no injection); the change only fixes search semantics so `50%`/`a_b` match literally.
2. **MEDIUM — logout inserts epoch-seconds `exp` into `TIMESTAMPTZ`.** Addressed. `POST /auth/logout` now specifies the explicit conversion `INSERT ... VALUES ($1,$2,to_timestamp($3))` with `$3` = decoded `exp` (seconds), and documents that a raw-number insert would raise a type error.
3. **NIT — "v4 UUID" jti guard uses `z.string().uuid()` (not v4-specific).** Addressed. Dropped the "v4" claim from auth-middleware step 3; the prose now states `z.string().uuid()` accepts any version and that its only job is to keep the UUID-typed blocklist lookup total, noting that our own `crypto.randomUUID()` already mints v4.
4. **NIT — upload error mapping ambiguous for multipart-with-no-file.** Addressed. Made the mapping Content-Type-driven in both `POST /tasks/:id/attachments` and Validation Rules: non-multipart Content-Type → 415; multipart with no `file` field → 400; `LIMIT_FILE_SIZE` → 413. Removed the overlapping "or multer producing no file" from the 415 clause.
5. **NIT — priority sort CASE redundant with native enum ordering.** Addressed. `GET /tasks` and the sort edge-case note now rely on native enum declaration-order ranking (`ORDER BY priority DESC NULLS LAST`); the CASE expression is removed.
6. **NIT — register response omits `updated_at`.** Addressed. `POST /auth/register` now returns `{ user: { id, name, email, created_at, updated_at } }` (set to `now()` on insert), matching `GET /users/me`.
7. **NIT — CITEXT uniqueness plus service lower-casing redundant.** Addressed. Validation Rules now state that under the chosen CITEXT path the unique index is the uniqueness mechanism and the service lower-casing is cosmetic normalization only (with a one-line note on the alternative TEXT path).

## Responses to Design Review (round 1)

This revision resolved every finding in the prior round's review.

1. **HIGH — BIGINT serialized as string (ids/`total`/comparisons).** Addressed. Added a decided **id serialization policy** (new subsection under Data Model): register a `pg` type parser for OID 20 so `int8`/`BIGINT` parse to JS `number`; ids and `pagination.total` are numbers end-to-end, `assignee=me` and all `===` id comparisons are number-vs-number, and the `< 2^53` precision ceiling is documented and accepted.
2. **HIGH — `GET /tasks` visibility SQL + count.** Addressed. Specified the exact base visibility predicate `(creator = me OR assignee = me OR project ∈ my projects)` with the optional filters `AND`-ed on, and stated that the identical predicate backs both the data query and `COUNT(*)`, so `total` can neither leak nor disagree with `data`.
3. **MEDIUM — projects payload shapes/sort.** Addressed. Defined the `GET /projects` row shape `{ id, name, description, owner_id, created_at, role }` with order `created_at DESC, id DESC`; defined the member object `{ user_id, name, email, role, joined_at }` and a deterministic member ordering for `GET /projects/:id`.
4. **MEDIUM — notification emission rule.** Addressed. Added a precise rule covering assignment-only, field-only, combined changes, actor-skip, and the empty-recipient case (no row, no emit).
5. **MEDIUM — project-less assignee existence.** Addressed. Stated that `assignee_id` existence is explicitly validated for project-less tasks; missing user → 400 VALIDATION_ERROR (FK `23503` also mapped to 400 as defense in depth). Reflected in `POST /tasks`.
6. **MEDIUM — PATCH setting `project_id` with no target-project authz.** Addressed. Added the rule that setting a non-null `project_id` requires caller membership of the target project (else 404), mirroring create-time; detaching to `null` needs only normal edit permission.
7. **MEDIUM — "row always written" vs actor-skip conflict.** Addressed. Reworded both the Real-time section and the error table to "one row per computed recipient inside the transaction; empty set → no row; emission best-effort after commit," consistent with finding 4.
8. **MEDIUM — `AI_UNAVAILABLE` missing/contradictory.** Addressed. Added `AI_UNAVAILABLE → 502` to the error-codes table and set the AI endpoint to return `error.code = "AI_UNAVAILABLE"` with HTTP 502; removed the "`INTERNAL`-coded" phrasing.
9. **MEDIUM — `jti` generation + blocklist-lookup robustness.** Addressed. Stated login generates a v4 UUID `jti` via `crypto.randomUUID()`, and added an ordered auth-middleware spec that validates `jti` is a UUID (401 if missing/malformed) before the UUID-typed blocklist query.
10. **NIT — description bounds in catalog.** Addressed. Added `description?: string(0..10000)` to task bodies, `description?: string(0..2000)` to project bodies, and echoed the project bound in Validation Rules.
11. **NIT — health 503 code.** Addressed. Added `SERVICE_UNAVAILABLE → 503` to the error table and switched `GET /health` to use it in the uniform error shape.
12. **NIT — `updated_at` rationale.** Addressed. Added a note explaining only `users` and `tasks` are mutable post-create, so other tables intentionally omit `updated_at`.

**Reviewer "unverified assumptions" also closed:** pinned `socket.io ^4.7` (handshake-auth behavior) and `vitest ^1.x`; settled serial-test configuration to a single authoritative `vitest.config.ts` spelling (`pool: 'forks'`, `singleFork`, `fileParallelism: false`); made the multer error mapping explicit per `MulterError.code` (`LIMIT_FILE_SIZE`→413, non-multipart→415, missing field→400); and eliminated the `node --loader` vs `tsx` ambiguity by standardizing on `tsx` for dev/CI TypeScript execution and compiled JS in the container.
