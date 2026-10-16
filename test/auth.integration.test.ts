import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Auth + users integration tests against a REAL Postgres. The suite is skipped
 * when no test database is configured (TEST_DATABASE_URL or DATABASE_URL), so
 * `npm test` stays green on machines/CI stages without a DB while still running
 * fully wherever a Postgres is reachable (compose db, CI postgres:15 service).
 *
 * To run locally: set DATABASE_URL (or TEST_DATABASE_URL) to a reachable
 * Postgres and `npm run migrate:dev`, then `npm test`.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

// The pool reads config.DATABASE_URL at import time; mirror TEST_DATABASE_URL
// onto DATABASE_URL before any src module is imported.
if (dbUrl && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = dbUrl;
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-at-least-16-chars-long';
}

describeDb('auth + users integration', () => {
  let app: Express;
  let buildApp: () => Express;
  let migrateTestDb: () => Promise<void>;
  let resetDb: () => Promise<void>;
  let pool: { end: () => Promise<void> };

  const creds = { name: 'Ada Lovelace', email: 'Ada@Example.com', password: 'correct horse battery' };

  beforeAll(async () => {
    ({ buildApp } = await import('../src/app.js'));
    ({ migrateTestDb, resetDb } = await import('./helpers/db.js'));
    ({ pool } = await import('../src/db/pool.js'));
    await migrateTestDb();
    app = buildApp();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function register(body = creds) {
    return request(app).post('/auth/register').send(body);
  }

  async function login(email = creds.email, password = creds.password) {
    return request(app).post('/auth/login').send({ email, password });
  }

  it('registers a user and never returns password_hash', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: creds.name, email: 'ada@example.com' });
    expect(res.body.user.id).toBeTypeOf('number');
    expect(res.body.user.created_at).toBeTruthy();
    expect(res.body.user.updated_at).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('rejects duplicate registration with 409 CONFLICT', async () => {
    await register();
    const res = await register({ ...creds, email: 'ADA@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('runs the full register -> login -> me -> patch -> logout -> reuse flow', async () => {
    await register();

    const loginRes = await login();
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeTypeOf('string');
    expect(JSON.stringify(loginRes.body)).not.toContain('password_hash');
    const token = loginRes.body.token as string;

    const meRes = await request(app).get('/users/me').set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe('ada@example.com');
    expect(meRes.body.user.password_hash).toBeUndefined();

    const patchRes = await request(app)
      .patch('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Augusta Ada King' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.user.name).toBe('Augusta Ada King');
    expect(JSON.stringify(patchRes.body)).not.toContain('password_hash');

    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body).toEqual({ status: 'logged_out' });

    // Reusing the (still signature-valid, unexpired) token must now 401.
    const reuseRes = await request(app).get('/users/me').set('Authorization', `Bearer ${token}`);
    expect(reuseRes.status).toBe(401);
    expect(reuseRes.body.error.code).toBe('UNAUTHENTICATED');

    // Logout is idempotent even after blocklisting is impossible with the dead
    // token; a second logout attempt with the dead token also 401s at the mw.
    const secondLogout = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(secondLogout.status).toBe(401);
  });

  it('re-hashes the password on PATCH so the new password logs in', async () => {
    await register();
    const token = (await login()).body.token as string;

    const patchRes = await request(app)
      .patch('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'a-brand-new-password' });
    expect(patchRes.status).toBe(200);

    expect((await login(creds.email, 'a-brand-new-password')).status).toBe(200);
    expect((await login(creds.email, creds.password)).status).toBe(401);
  });

  it('returns 409 when PATCH email collides with another user', async () => {
    await register();
    await register({ name: 'Grace', email: 'grace@example.com', password: 'another-password' });
    const token = (await login('grace@example.com', 'another-password')).body.token as string;

    const res = await request(app)
      .patch('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'ada@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects bad credentials with a generic 401 (no email echoed)', async () => {
    await register();
    const res = await login(creds.email, 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(res.body)).not.toContain(creds.email.toLowerCase());

    const unknown = await login('nobody@example.com', 'whatever-password');
    expect(unknown.status).toBe(401);
  });

  it('rejects an empty PATCH body with 400 VALIDATION_ERROR', async () => {
    await register();
    const token = (await login()).body.token as string;
    const res = await request(app)
      .patch('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing, garbled, and non-UUID-jti tokens with 401', async () => {
    // No header.
    expect((await request(app).get('/users/me')).status).toBe(401);
    // Garbled bearer token.
    expect(
      (await request(app).get('/users/me').set('Authorization', 'Bearer not-a-jwt')).status
    ).toBe(401);

    // A validly-signed token whose jti is not a UUID must 401 at the guard,
    // before the blocklist query.
    const jwt = (await import('jsonwebtoken')).default;
    const badJti = jwt.sign({ jti: 'not-a-uuid' }, process.env.JWT_SECRET as string, {
      subject: '1',
      expiresIn: 60,
    });
    expect(
      (await request(app).get('/users/me').set('Authorization', `Bearer ${badJti}`)).status
    ).toBe(401);
  });

  it('rejects a token whose user no longer exists with 401', async () => {
    await register();
    const token = (await login()).body.token as string;
    await resetDb();
    const res = await request(app).get('/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
