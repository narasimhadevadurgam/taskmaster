# Design Review — Task Manager Backend

Reviewed: `.agents/tasks/design.md` (round 3 revision; the doc records two prior review rounds).
Repo state: greenfield. The only non-git content under `task-manager/` is `.agents/tasks/` (`design.md`, prior `design-review.md`/`.json`). There is no `src/`, `package.json`, `migrations/`, or any other source to verify the design against, so "unverified assumptions" below concern documented library/runtime behaviors and the design's internal consistency, not existing code.

This is a strong, concrete design. The two prior review rounds resolved the big structural issues (BIGINT serialization, visibility SQL + count parity, notification recipient rule, PATCH target-project authz, AI error code). The findings below are what remains: a small number of real gaps and ambiguities that would otherwise force the implementer to invent a contract.

## Findings

### 1. MEDIUM — `GET /tasks` `priority` sort depends on enum ordering, but the brief's default sort is undefined for the two non-enum sort keys' NULLS handling only partially specified
Location: REST API → `GET /tasks`; Edge Cases → "Sort by nullable priority/due_date".

The design states `ORDER BY t.priority DESC NULLS LAST` and "deterministic tie-break by `id`". For `due_date` (nullable) the NULLS placement is only mentioned in the edge-case note ("explicit NULLS LAST") but the `GET /tasks` catalog entry does not state the NULLS rule for `due_date` under both `asc` and `order` combinations. With `order=asc` on `due_date`, `NULLS LAST` vs the SQL default (`NULLS FIRST` for ASC) changes results. The implementer has two valid interpretations.

Concrete fix: in the `GET /tasks` entry, state the rule explicitly for every sort column and both orders, e.g. "all sorts append `NULLS LAST` regardless of `order`, then `, id <order>` as the final tie-break", and give the exact ORDER BY template:
```
ORDER BY <sortcol> <order> NULLS LAST, id <order>
```

### 2. MEDIUM — Combined id tie-break direction is unspecified and can break stable pagination
Location: REST API → `GET /tasks`, `GET /projects` ("ORDER BY created_at DESC, id DESC").

`GET /projects` fixes the tie-break as `id DESC`. `GET /tasks` says "deterministic tie-break by `id` appended to every sort" but does not fix the direction. If the primary sort is `order=asc` and the id tie-break is hard-coded `DESC` (or vice versa), pagination is still deterministic but the ordering within a tie group is arbitrary relative to the user's chosen direction — acceptable, but it must be pinned so data query and count/next-page use the identical clause. More importantly, the clause must be byte-identical between the paginated SELECT and any re-query; leaving the direction unstated invites drift.

Concrete fix: pin the tie-break to follow `order` (`, id <order>`) as in finding 1's template, and state it once as the single authoritative ORDER BY form reused across pages.

### 3. MEDIUM — `GET /tasks` task response shape is never defined
Location: REST API → `GET /tasks`, `GET /tasks/:id`, `POST /tasks`, `PATCH /tasks/:id` (all say `{ task: {...} }`).

Every task endpoint returns `{ task: {...} }` but the field list of the task object is never enumerated anywhere in the doc (unlike `user`, `project`, project `member`, and `attachment`, which are all spelled out). The implementer must guess whether the task payload includes `creator_id`, `assignee_id`, `project_id`, `created_at`, `updated_at`, and whether it embeds any joined names. This is a missing contract on the single most-used resource.

Concrete fix: add a canonical task response shape, e.g.
```
task: { id, title, description, status, priority, due_date, creator_id, assignee_id, project_id, created_at, updated_at }
```
and state that all four task endpoints return this identical shape.

### 4. MEDIUM — Comment, notification, and `GET /tasks` list item shapes are undefined
Location: `POST/GET /tasks/:id/comments`, `GET /notifications`, `PATCH /notifications/:id`.

Same class as finding 3. `{ comment: {...} }`, `{ notification: {...} }`, and the comment/notification list items are referenced but never given a field list. For notifications the `payload` JSONB is described as "denormalized task snapshot" with no stated keys, so a client cannot know what it will receive.

Concrete fix: enumerate `comment: { id, task_id, author_id, body, created_at }`, `notification: { id, user_id, type, payload, read, created_at }`, and specify the `payload` snapshot keys (e.g. `{ task_id, title, status, project_id, actor_id }`) so the real-time event and REST fallback agree.

### 5. MEDIUM — `GET /tasks` `assignee` filter semantics vs visibility can silently return empty, but `project` filter note is contradictory about what "membership" admits
Location: REST API → `GET /tasks`, visibility+filter SQL block and the trailing paragraph.

The trailing paragraph says a caller filtering by a `project` they are not a member of "still only sees tasks the base predicate admits (i.e. tasks in that project where they are creator/assignee)". That is correct given the SQL. But the base predicate's third disjunct is `t.project_id IN (SELECT ... WHERE user_id = $me)` — for a non-member-project filter, that disjunct contributes nothing, which is the intended behavior. The contradiction is subtle: the prose implies creator/assignee tasks in a foreign project are visible, which the SQL does deliver, so this is consistent. However, there is a genuine gap: the `assignee` filter accepts an arbitrary numeric user id, and the design does not state what happens when that id is a user the caller shares no visibility with — the result is simply the base predicate intersected with `assignee_id = $assignee`, which is fine, but should be stated so the implementer does not add an extra authz check that would 403/404.

Concrete fix: add one sentence to `GET /tasks`: "the `assignee` and `project` filters are pure `AND` narrowings of the base visibility predicate; a filter value the caller cannot otherwise see simply yields fewer/zero rows and is never itself an authorization error."

### 6. NIT — Logout does not verify the token's user matches a loaded user / revocation of an already-expired token
Location: `POST /auth/logout`.

Logout runs under the normal auth middleware (step 5 loads the user), so `req.user.id` is trusted — fine. The `ON CONFLICT (jti) DO NOTHING` makes it idempotent. No change required to correctness, but the doc should note that logout is only reachable for a still-valid token (expired tokens 401 at the middleware), so the blocklist never needs to store already-expired `exp` values; the prune story already covers cleanup.

Concrete fix: one clarifying sentence; no behavioral change.

### 7. NIT — `POST /projects/:id/members` body `{ user_id?: number } | { email? }` "exactly one" rule needs an explicit zod form
Location: REST API → `POST /projects/:id/members`; Validation Rules.

The "exactly one of user_id | email" constraint is a cross-field rule that `z.object` does not express without a `.refine`/`.superRefine`. The design says "exactly one" but does not pin the schema shape, so the implementer could allow both or neither.

Concrete fix: specify `z.object({ user_id: ..., email: ... }).refine(d => (d.user_id == null) !== (d.email == null), 'provide exactly one of user_id or email')` and the resulting VALIDATION_ERROR on both-or-neither.

### 8. NIT — `PATCH /notifications/:id` body fixed to `{ read: true }` cannot mark unread
Location: `PATCH /notifications/:id`.

Body is `{ read: true }` (literal true). That is a deliberate narrowing and the brief never asks for mark-unread, so this is in scope. Worth noting only so the implementer uses `z.object({ read: z.literal(true) })` rather than `z.boolean()` (which would silently accept `false` and do nothing).

Concrete fix: state `read: z.literal(true)`.

### 9. NIT — `due_date` is `TIMESTAMPTZ` but the brief/user stories say "due date"; time-of-day semantics unstated
Location: tasks table; `POST /tasks` `due_date?: ISO datetime`.

Storing a full `TIMESTAMPTZ` for a "due date" is a reasonable choice, but the input validator is "ISO 8601 datetime" — a client sending a date-only `2025-01-31` would fail `z.string().datetime()`. This is a minor UX contract point, not a correctness bug.

Concrete fix: either accept date-only and coerce to end-of-day UTC, or document that `due_date` requires a full ISO datetime and clients must supply time. Pick one explicitly.

## Verified Assumptions

Verified against well-established, stable library/runtime behavior (greenfield repo, so no project source exists yet to read):

- **`node-postgres` returns `int8`/`BIGINT` as JS strings by default, and OID 20 is `int8`.** The design's `pg.types.setTypeParser(20, ...)` to coerce to `number` is the correct mechanism, and `COUNT(*)` (also int8) is covered by the same parser. Correct.
- **PostgreSQL orders ENUM columns by declaration order.** Declaring `task_priority AS ENUM ('low','medium','high')` makes `ORDER BY priority DESC` yield high→medium→low without a CASE expression. Correct.
- **socket.io v4 exposes handshake auth at `socket.handshake.auth.token`** (client sends via `io(url, { auth: { token } })`). Correct and matches the documented connect flow.
- **`crypto.randomUUID()` produces a v4 UUID**, so `z.string().uuid()` (version-agnostic) in the auth middleware is sufficient to keep the UUID-typed blocklist lookup total. Correct.
- **Vitest v1 serial config** `test: { pool: 'forks', poolOptions: { forks: { singleFork: true } }, fileParallelism: false }` is the valid v1 spelling. Correct.
- **multer raises `MulterError` with `code === 'LIMIT_FILE_SIZE'`** on oversize and `LIMIT_UNEXPECTED_FILE` on unexpected fields. The design's mapping (415 non-multipart → 413 size → 400 missing/other) is implementable. Correct.
- **zod `z.coerce.number().int().positive()`** coerces string query/param values to numbers, consistent with the number-id contract. Correct.
- **Postgres `to_timestamp(epoch_seconds)` returns `TIMESTAMPTZ`**, so the logout insert `VALUES ($1,$2,to_timestamp($3))` is the correct conversion from a numeric JWT `exp`. Correct.
- **`CITEXT` provides case-insensitive uniqueness** via a unique index, making service-side lower-casing cosmetic. Correct; the migration must `CREATE EXTENSION citext`, which the design states.

## Unverified / Wrong Assumptions

- **No wrong assumptions found.** The design's load-bearing library claims (pg type parsing, enum ordering, socket.io handshake, multer error codes, Vitest v1 config, `to_timestamp`) are accurate.
- **Could not verify (greenfield, by nature):** there is no implementation, lockfile, or `package.json` to confirm the pinned versions (`socket.io ^4.7`, `vitest ^1.x`, Express 4, `pg`, zod) actually resolve and interoperate on the target Node 20 LTS. This is expected for a pre-implementation design and is not itself a finding; the implementer must confirm the versions install and typecheck together during setup.

## Verdict

HIGH findings: 0. MEDIUM findings: 5 (#1–#5). NIT findings: 4 (#6–#9).

MEDIUM count > 0 → **CHANGES_REQUESTED**.

The required changes are all contract-specification gaps (response shapes for task/comment/notification, the exact ORDER BY/NULLS/tie-break template, and one filter-semantics sentence), not architectural rework. Pinning these down removes the remaining room for the implementer to invent incompatible contracts.
