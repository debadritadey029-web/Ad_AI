import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { apiRouter } from '../routes.js';
import { createSession, revokeSession } from '../services/auth.js';

const migrationUrl = new URL('../../../supabase/migrations/20261022_normalized_campaign_persistence.sql', import.meta.url);
const migration = readFileSync(fileURLToPath(migrationUrl), 'utf8');

test('database migration uses tenant-scoped normalized campaign records and atomic version checks', () => {
  assert.match(migration, /create table if not exists public\.app_campaigns/i);
  assert.match(migration, /org_id text not null references public\.organizations\(id\)/i);
  assert.match(migration, /unique \(org_id, id\)/i);
  assert.match(migration, /p_expected_version integer/i);
  assert.match(migration, /campaign_version_conflict/i);
  assert.match(migration, /revoke all on table public\.app_campaigns from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.app_create_campaign\(jsonb,jsonb\) to service_role/i);
});

test('campaign mutations append tamper-evident audit events in the same database transaction', () => {
  assert.match(migration, /create table if not exists public\.app_audit_events/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /digest\(convert_to\(v_previous_hash/i);
  assert.match(migration, /perform public\.app_append_audit_event\([\s\S]*CAMPAIGN_CREATED/i);
  assert.match(migration, /perform public\.app_append_audit_event\([\s\S]*CAMPAIGN_STATUS_UPDATED/i);
  assert.match(migration, /revoke all on table public\.app_audit_events from public, anon, authenticated/i);
});

test('Vercel blocks writes for domains not yet backed by durable repositories after authentication', async () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  const session = createSession({ userId: 'usr_sarah', activeOrgId: 'org_apex' });
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${address.port}/api/finance/proposals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`http://127.0.0.1:${address.port}/api/finance/proposals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(authenticated.status, 503);
    const body = await authenticated.json() as { error?: string };
    assert.equal(body.error, 'DURABLE_PERSISTENCE_NOT_IMPLEMENTED');

    const nonDurableRead = await fetch(`http://127.0.0.1:${address.port}/api/finance/proposals`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(nonDurableRead.status, 503);
    const readBody = await nonDurableRead.json() as { error?: string };
    assert.equal(readBody.error, 'DURABLE_PERSISTENCE_NOT_IMPLEMENTED');
  } finally {
    revokeSession(session.token);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});
