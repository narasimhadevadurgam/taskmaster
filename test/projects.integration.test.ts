import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Projects + tasks + comments + attachments integration suite against a REAL
 * Postgres. Skipped cleanly when no test DB is configured so
 * `npm test` stays green on DB-less stages while running fully wherever a
 * Postgres is reachable.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

if (dbUrl && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = dbUrl;
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-at-least-16-chars-long';
}

describeDb('projects/tasks/comments/attachments integration', () => {
  let app: Express;
  let pool: { end: () => Promise<void> };

  beforeAll(async () => {
    const appMod = await import('../src/app.js');
    const helpers = await import('./helpers/db.js');
    ({ pool } = await import('../src/db/pool.js'));
    await helpers.migrateTestDb();
    app = appMod.buildApp();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const { resetDb } = await import('./helpers/db.js');
    await resetDb();
  });

  // --- helpers ---------------------------------------------------------------

  async function makeUser(name: string, email: string) {
    const password = 'correct horse battery';
    await request(app).post('/auth/register').send({ name, email, password });
    const res = await request(app).post('/auth/login').send({ email, password });
    return { id: res.body.user.id as number, token: res.body.token as string };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // --- projects --------------------------------------------------------------

  it('creates a project with the caller as owner member', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const res = await request(app)
      .post('/projects')
      .set(auth(owner.token))
      .send({ name: 'Alpha', description: 'first' });
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ name: 'Alpha', owner_id: owner.id });
    expect(res.body.project.id).toBeTypeOf('number');

    const get = await request(app)
      .get(`/projects/${res.body.project.id}`)
      .set(auth(owner.token));
    expect(get.status).toBe(200);
    expect(get.body.members).toHaveLength(1);
    expect(get.body.members[0]).toMatchObject({ user_id: owner.id, role: 'owner' });
  });

  it('owner can add a member; non-owner member gets 403; duplicate 409', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const bob = await makeUser('Bob', 'bob@example.com');
    const carol = await makeUser('Carol', 'carol@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;

    const add = await request(app)
      .post(`/projects/${project.id}/members`)
      .set(auth(owner.token))
      .send({ user_id: bob.id });
    expect(add.status).toBe(201);
    expect(add.body.member).toMatchObject({ user_id: bob.id, role: 'member' });

    // Duplicate -> 409.
    const dup = await request(app)
      .post(`/projects/${project.id}/members`)
      .set(auth(owner.token))
      .send({ email: 'bob@example.com' });
    expect(dup.status).toBe(409);

    // Non-owner member tries to add -> 403.
    const forbidden = await request(app)
      .post(`/projects/${project.id}/members`)
      .set(auth(bob.token))
      .send({ user_id: carol.id });
    expect(forbidden.status).toBe(403);
  });

  it('member-add requires exactly one of user_id|email (XOR)', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;

    const both = await request(app)
      .post(`/projects/${project.id}/members`)
      .set(auth(owner.token))
      .send({ user_id: 1, email: 'x@example.com' });
    expect(both.status).toBe(400);

    const neither = await request(app)
      .post(`/projects/${project.id}/members`)
      .set(auth(owner.token))
      .send({});
    expect(neither.status).toBe(400);
  });

  it('non-member cannot see a project (404)', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const stranger = await makeUser('Stranger', 'stranger@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;

    const res = await request(app).get(`/projects/${project.id}`).set(auth(stranger.token));
    expect(res.status).toBe(404);
  });

  it('lists only projects the caller owns or belongs to', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const bob = await makeUser('Bob', 'bob@example.com');
    const p1 = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;
    await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Beta' });
    await request(app)
      .post(`/projects/${p1.id}/members`)
      .set(auth(owner.token))
      .send({ user_id: bob.id });

    const bobList = await request(app).get('/projects').set(auth(bob.token));
    expect(bobList.status).toBe(200);
    expect(bobList.body.data).toHaveLength(1);
    expect(bobList.body.data[0]).toMatchObject({ name: 'Alpha', role: 'member' });
    expect(bobList.body.pagination.total).toBe(1);
  });

  // --- tasks CRUD ------------------------------------------------------------

  it('creates, reads, updates (mark completed) and deletes a task', async () => {
    const u = await makeUser('U', 'u@example.com');
    const create = await request(app)
      .post('/tasks')
      .set(auth(u.token))
      .send({ title: 'Write report', description: 'draft' });
    expect(create.status).toBe(201);
    const task = create.body.task;
    expect(task).toMatchObject({ title: 'Write report', creator_id: u.id, status: 'open' });

    const get = await request(app).get(`/tasks/${task.id}`).set(auth(u.token));
    expect(get.status).toBe(200);

    const patch = await request(app)
      .patch(`/tasks/${task.id}`)
      .set(auth(u.token))
      .send({ status: 'completed' });
    expect(patch.status).toBe(200);
    expect(patch.body.task.status).toBe('completed');

    const del = await request(app).delete(`/tasks/${task.id}`).set(auth(u.token));
    expect(del.status).toBe(204);
    expect((await request(app).get(`/tasks/${task.id}`).set(auth(u.token))).status).toBe(404);
  });

  it('assignment invariant: non-member -> 400, non-existent user -> 400', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const outsider = await makeUser('Out', 'out@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;

    // Project task assigned to a non-member -> 400.
    const nonMember = await request(app)
      .post('/tasks')
      .set(auth(owner.token))
      .send({ title: 'T', project_id: project.id, assignee_id: outsider.id });
    expect(nonMember.status).toBe(400);

    // Project-less task assigned to a non-existent user -> 400.
    const ghost = await request(app)
      .post('/tasks')
      .set(auth(owner.token))
      .send({ title: 'T', assignee_id: 999999 });
    expect(ghost.status).toBe(400);
  });

  it('creating a task in a project the caller is not a member of -> 404', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const stranger = await makeUser('Stranger', 'stranger@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;

    const res = await request(app)
      .post('/tasks')
      .set(auth(stranger.token))
      .send({ title: 'T', project_id: project.id });
    expect(res.status).toBe(404);
  });

  it('moving a task into a project the caller is not a member of -> 404', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const stranger = await makeUser('Stranger', 'stranger@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;
    // Stranger owns a project-less task.
    const task = (
      await request(app).post('/tasks').set(auth(stranger.token)).send({ title: 'T' })
    ).body.task;

    const res = await request(app)
      .patch(`/tasks/${task.id}`)
      .set(auth(stranger.token))
      .send({ project_id: project.id });
    expect(res.status).toBe(404);
  });

  it('task visibility: non-visible -> 404 on GET and PATCH', async () => {
    const u = await makeUser('U', 'u@example.com');
    const other = await makeUser('O', 'o@example.com');
    const task = (
      await request(app).post('/tasks').set(auth(u.token)).send({ title: 'Private' })
    ).body.task;

    expect((await request(app).get(`/tasks/${task.id}`).set(auth(other.token))).status).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/tasks/${task.id}`)
          .set(auth(other.token))
          .send({ title: 'hijack' })
      ).status
    ).toBe(404);
  });

  it('delete authz: non-creator/non-owner (assignee) -> 403', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const member = await makeUser('M', 'm@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;
    await request(app)
      .post(`/projects/${project.id}/members`)
      .set(auth(owner.token))
      .send({ user_id: member.id });
    const task = (
      await request(app)
        .post('/tasks')
        .set(auth(owner.token))
        .send({ title: 'T', project_id: project.id, assignee_id: member.id })
    ).body.task;

    // Assignee can see it (visible) but may not delete -> 403.
    const del = await request(app).delete(`/tasks/${task.id}`).set(auth(member.token));
    expect(del.status).toBe(403);
    // Project owner may delete.
    expect((await request(app).delete(`/tasks/${task.id}`).set(auth(owner.token))).status).toBe(
      204
    );
  });

  // --- GET /tasks filter / sort / search / pagination ------------------------

  it('filters by status, assignee=me and project; q is a literal substring', async () => {
    const owner = await makeUser('Owner', 'owner@example.com');
    const project = (
      await request(app).post('/projects').set(auth(owner.token)).send({ name: 'Alpha' })
    ).body.project;

    await request(app)
      .post('/tasks')
      .set(auth(owner.token))
      .send({ title: 'Discount 50% off', status: 'open', project_id: project.id });
    await request(app)
      .post('/tasks')
      .set(auth(owner.token))
      .send({ title: 'Discount 5000 off', status: 'open', project_id: project.id });
    await request(app)
      .post('/tasks')
      .set(auth(owner.token))
      .send({ title: 'Done thing', status: 'completed', project_id: project.id });

    // status filter.
    const open = await request(app).get('/tasks?status=open').set(auth(owner.token));
    expect(open.body.data).toHaveLength(2);
    expect(open.body.pagination.total).toBe(2);

    // assignee=me (owner created but no assignee) -> none.
    const mine = await request(app).get('/tasks?assignee=me').set(auth(owner.token));
    expect(mine.body.data).toHaveLength(0);

    // project filter.
    const byProject = await request(app)
      .get(`/tasks?project=${project.id}`)
      .set(auth(owner.token));
    expect(byProject.body.pagination.total).toBe(3);

    // q literal substring: '50%' matches ONLY the '50% off' title (not 5000).
    const q = await request(app).get('/tasks?q=50%25').set(auth(owner.token));
    expect(q.body.data).toHaveLength(1);
    expect(q.body.data[0].title).toBe('Discount 50% off');
  });

  it('sorts by due_date/created_at/priority with NULLS LAST and stable id tie-break', async () => {
    const u = await makeUser('U', 'u@example.com');
    const mk = (body: Record<string, unknown>) =>
      request(app).post('/tasks').set(auth(u.token)).send(body);

    await mk({ title: 'no-due' }); // due_date null
    await mk({ title: 'early', due_date: '2025-01-01T00:00:00Z' });
    await mk({ title: 'late', due_date: '2025-12-31T00:00:00Z' });

    const asc = await request(app).get('/tasks?sort=due_date&order=asc').set(auth(u.token));
    const titlesAsc = asc.body.data.map((t: { title: string }) => t.title);
    // NULLS LAST under asc: early, late, no-due.
    expect(titlesAsc).toEqual(['early', 'late', 'no-due']);

    const desc = await request(app).get('/tasks?sort=due_date&order=desc').set(auth(u.token));
    const titlesDesc = desc.body.data.map((t: { title: string }) => t.title);
    // NULLS LAST under desc: late, early, no-due.
    expect(titlesDesc).toEqual(['late', 'early', 'no-due']);

    // priority native enum ordering high>medium>low under desc, NULLS LAST.
    await mk({ title: 'p-high', priority: 'high' });
    await mk({ title: 'p-low', priority: 'low' });
    const prio = await request(app).get('/tasks?sort=priority&order=desc').set(auth(u.token));
    const prioTitles = prio.body.data.map((t: { title: string }) => t.title);
    expect(prioTitles.indexOf('p-high')).toBeLessThan(prioTitles.indexOf('p-low'));
  });

  it('paginates with total matching the predicate', async () => {
    const u = await makeUser('U', 'u@example.com');
    for (let n = 0; n < 5; n++) {
      await request(app).post('/tasks').set(auth(u.token)).send({ title: `t${n}` });
    }
    const page = await request(app).get('/tasks?limit=2&offset=0').set(auth(u.token));
    expect(page.body.data).toHaveLength(2);
    expect(page.body.pagination).toMatchObject({ limit: 2, offset: 0, total: 5 });
  });

  // --- comments --------------------------------------------------------------

  it('comments: create/list require task-visibility', async () => {
    const u = await makeUser('U', 'u@example.com');
    const other = await makeUser('O', 'o@example.com');
    const task = (
      await request(app).post('/tasks').set(auth(u.token)).send({ title: 'T' })
    ).body.task;

    const create = await request(app)
      .post(`/tasks/${task.id}/comments`)
      .set(auth(u.token))
      .send({ body: 'first comment' });
    expect(create.status).toBe(201);
    expect(create.body.comment).toMatchObject({ task_id: task.id, author_id: u.id, body: 'first comment' });

    const list = await request(app).get(`/tasks/${task.id}/comments`).set(auth(u.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    // A non-visible task -> 404 on both.
    expect(
      (
        await request(app)
          .post(`/tasks/${task.id}/comments`)
          .set(auth(other.token))
          .send({ body: 'x' })
      ).status
    ).toBe(404);
    expect(
      (await request(app).get(`/tasks/${task.id}/comments`).set(auth(other.token))).status
    ).toBe(404);
  });

  // --- attachments -----------------------------------------------------------

  it('attachment upload ok (no path leaked), list, authz download; 415/400/413', async () => {
    const u = await makeUser('U', 'u@example.com');
    const other = await makeUser('O', 'o@example.com');
    const task = (
      await request(app).post('/tasks').set(auth(u.token)).send({ title: 'T' })
    ).body.task;

    // OK upload.
    const ok = await request(app)
      .post(`/tasks/${task.id}/attachments`)
      .set(auth(u.token))
      .attach('file', Buffer.from('hello world'), 'notes.txt');
    expect(ok.status).toBe(201);
    expect(ok.body.attachment).toMatchObject({
      task_id: task.id,
      uploader_id: u.id,
      filename: 'notes.txt',
    });
    expect(ok.body.attachment.mime_type).toBeTruthy();
    expect(ok.body.attachment.size_bytes).toBeTypeOf('number');
    // Server path must never leak.
    expect(JSON.stringify(ok.body)).not.toContain('path');
    expect(ok.body.attachment.path).toBeUndefined();

    // 415: non-multipart content-type.
    const wrongType = await request(app)
      .post(`/tasks/${task.id}/attachments`)
      .set(auth(u.token))
      .set('Content-Type', 'application/json')
      .send({ not: 'a file' });
    expect(wrongType.status).toBe(415);

    // 400: multipart but no `file` field.
    const noFile = await request(app)
      .post(`/tasks/${task.id}/attachments`)
      .set(auth(u.token))
      .field('other', 'x');
    expect(noFile.status).toBe(400);

    // list.
    const list = await request(app).get(`/tasks/${task.id}/attachments`).set(auth(u.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('"path"');

    // authz-checked download: owner ok, non-visible -> 404.
    const attId = ok.body.attachment.id;
    const dl = await request(app).get(`/attachments/${attId}/download`).set(auth(u.token));
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('hello world');

    const dlForbidden = await request(app)
      .get(`/attachments/${attId}/download`)
      .set(auth(other.token));
    expect(dlForbidden.status).toBe(404);
  });

  it('413 when an upload exceeds MAX_UPLOAD_BYTES', async () => {
    // This test is only meaningful if MAX_UPLOAD_BYTES is small; the default is
    // 10MB. We rely on the default and skip the oversize assertion when it would
    // require allocating a >10MB buffer. Keep a modest guard: upload a buffer
    // just over a locally-reduced cap when provided via env.
    const cap = Number(process.env.MAX_UPLOAD_BYTES ?? '10485760');
    const u = await makeUser('U', 'u@example.com');
    const task = (
      await request(app).post('/tasks').set(auth(u.token)).send({ title: 'T' })
    ).body.task;
    const oversize = Buffer.alloc(cap + 1, 1);
    const res = await request(app)
      .post(`/tasks/${task.id}/attachments`)
      .set(auth(u.token))
      .attach('file', oversize, 'big.bin');
    expect(res.status).toBe(413);
  });
});
