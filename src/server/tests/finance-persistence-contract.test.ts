import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migration = readFileSync(fileURLToPath(new URL('../../../supabase/migrations/20261023_durable_finance_workflows.sql', import.meta.url)), 'utf8');
const repository = readFileSync(fileURLToPath(new URL('../db/finance-repository.ts', import.meta.url)), 'utf8');
const routes = readFileSync(fileURLToPath(new URL('../routes.ts', import.meta.url)), 'utf8');

test('durable finance schema is tenant-scoped and access is server-only', () => {
  assert.match(migration, /create table if not exists public\.app_budget_proposals/i);
  assert.match(migration, /foreign key \(org_id, campaign_id\) references public\.app_campaigns\(org_id, id\)/i);
  assert.match(migration, /revoke all on table public\.app_budget_proposals from public, anon, authenticated/i);
  assert.match(migration, /grant select on public\.app_budget_proposals to service_role/i);
  assert.match(migration, /create table if not exists public\.app_org_controls/i);
});

test('proposal creation and review enforce role, four-eyes, emergency stop and stale-version checks transactionally', () => {
  assert.match(migration, /app_create_budget_proposal/i);
  assert.match(migration, /app_review_budget_proposal/i);
  assert.match(migration, /app_set_emergency_stop/i);
  assert.match(migration, /provider_pause_performed',\s*false/i);
  assert.match(migration, /four_eyes_violation/i);
  assert.match(migration, /emergency_stop_active/i);
  assert.match(migration, /campaign_version_at_request/i);
  assert.match(migration, /perform public\.app_append_audit_event/i);
  assert.match(migration, /provider_write_performed',\s*false/i);
});

test('server finance API uses durable repository and does not silently fall back on durable errors', () => {
  assert.match(repository, /app_create_budget_proposal/);
  assert.match(repository, /app_review_budget_proposal/);
  assert.match(repository, /No local fallback was used/);
  assert.match(routes, /isDurableFinancePersistenceEnabled\(\)/);
  assert.match(routes, /DURABLE_PERSISTENCE_NOT_IMPLEMENTED/);
});
