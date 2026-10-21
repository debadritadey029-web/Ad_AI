import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { apiRouter } from '../routes.js';
import { createSession, revokeSession } from '../services/auth.js';

test('API security: protected auth context rejects requests without a session token', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/context`);
    assert.equal(response.status, 401);
    const body = await response.json() as { error?: string };
    assert.equal(body.error, 'UNAUTHENTICATED');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('API security: auth context does not return a reusable fallback session token', async () => {
  const session = createSession({ userId: 'usr_sarah', activeOrgId: 'org_apex' });
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/context`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'sessionToken'), false);
    assert.equal((body.user as { id: string }).id, 'usr_sarah');
  } finally {
    revokeSession(session.token);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test('API security: organization listing includes only active organizations for the signed-in user', async () => {
  const session = createSession({ userId: 'usr_sarah', activeOrgId: 'org_apex' });
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/organizations`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(response.status, 200);
    const organizations = await response.json() as Array<{ id: string }>;
    assert.ok(organizations.length > 0);
    const activeMembershipOrgIds = new Set(
      Array.from((await import('../db/store.js')).globalStore.memberships.values())
        .filter((membership) => membership.userId === 'usr_sarah' && membership.status === 'ACTIVE')
        .map((membership) => membership.orgId)
    );
    assert.ok(organizations.every((organization) => activeMembershipOrgIds.has(organization.id)));
  } finally {
    revokeSession(session.token);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('API security: invalid bearer tokens cannot fall back to a seeded identity', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/context`, {
      headers: { Authorization: 'Bearer not-a-valid-session-or-supabase-token' },
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
