# Security Remediation Status

This document records the scope of the critical-security remediation branch. It is not a production certification.

## Implemented in this branch

- Protected API requests now require a valid session token; no unauthenticated fallback identity is selected.
- Static tester session tokens are not seeded when `NODE_ENV=production`.
- Demo sign-in and user switching are disabled unless explicitly opted in outside production.
- The auth-context endpoint returns only the signed-in user's profile and organizations where that user has an active membership; it no longer returns a fallback token.
- Session creation requires a known user with active membership in the selected organization.
- OTP responses do not expose development codes unless `ENABLE_DEV_OTP_CODE=true` in a non-production environment.
- Automatic account provisioning into a shared default organization has been removed from OTP sign-in.
- Production password/OTP sign-in intentionally fails closed with a clear 503 until an actual email/SMS delivery adapter is configured. This avoids fake OTP delivery and authentication bypass.
- Campaign creation creates a local `DRAFT`, not an `ACTIVE` ad. Campaign activation is rejected until provider publishing is implemented.
- Budget approval is recorded as `APPROVED`, not `EXECUTED`, when there is no provider budget-write call.
- Emergency-stop messaging now states that its effect is local-only; provider-side pause calls are not implemented.
- Provider sync no longer reports a fake healthy sync; it returns a clear not-implemented response and records an error state.
- Campaign and lead statuses, emergency-stop actions, budget review actions, provider IDs, and provider-sync permissions receive additional validation.
- Added regression tests for production demo/OTP-code policy and session membership requirements.

## Vercel API and health checks

- The repository now includes `api/[...path].ts`, a Vercel Node.js catch-all that mounts the secured Express API; `vercel.json` leaves API function routing to Vercel and retains the SPA fallback for frontend routes.
- The catch-all has a regression test for protected-route authorization and baseline security headers.
- Public `/api/health` no longer reports tenant/user/campaign counts. It reports process liveness only and explicitly does not claim production readiness.
- `/api/health/ready` deliberately returns HTTP 503 until durable transactional tenant-scoped persistence is implemented. This is an intentional release gate, not a failed Supabase login.
- CI now runs on pushes to this branch and a separate CodeQL workflow performs scheduled and pull-request JavaScript/TypeScript analysis. Wait for the new checks to finish before treating the latest commit as validated.

## Phase 2: transactional campaign persistence

- Added `supabase/migrations/20261022_normalized_campaign_persistence.sql`, which creates normalized `app_campaigns` and append-only `app_audit_events` tables, tenant indexes, server-only privileges, and service-role-only transactional RPCs.
- Campaign list/create/status operations use the normalized repository whenever Supabase server credentials are configured. Database errors fail closed; they never fall back to the process-local map.
- Campaign status updates use optimistic version checks; concurrent stale writes return a conflict instead of overwriting newer state.
- Campaign creation and status changes append hash-chained audit events inside the same database transaction as the campaign mutation.
- On Vercel, whole-state snapshot writes are disabled. Reads and mutations for other domains that do not yet have durable transactional repositories return HTTP 503 after authentication; they do not expose seeded snapshot data as customer data or claim success based on an ephemeral in-memory write.
- New database contract tests check tenant scoping, optimistic concurrency, audit chaining, and the serverless write gate.

### Phase 2 scope limitation

Campaign list/create/status and budget proposal creation/review now have normalized durable repositories and transactional PostgreSQL functions. Organization settings/emergency-stop state, provider connections, creatives, leads, analytics, and a durable audit read API still need dedicated repositories/workflows. The readiness endpoint must remain closed until those domains and real browser E2E coverage are complete.

## Explicit release blockers still open

1. **Production authentication delivery:** configure and implement an email/SMS OTP provider (including delivery errors, retry handling, verification limits, and operational monitoring) before production login can be enabled.
2. **Shared durable persistence and sessions:** the current store is an in-memory Map plus a whole-state snapshot. It is not safe for concurrent serverless instances. Supabase Auth tokens are validated, but campaign/finance data and legacy sessions are not fully migrated to transactional tenant-scoped tables/shared persistence. Replace this before production.
3. **Real provider adapters:** Meta, TikTok, Google, WhatsApp Business, and other providers still require real OAuth callback handling, encrypted token storage/rotation, provider API calls, retries, idempotency, and provider-side verification. The UI must not imply these actions are live.
4. **Browser end-to-end tests:** execute login, tenant isolation, campaign/finance flows, and responsive checks in a real browser against an isolated staging database. A typecheck/build alone is not end-to-end proof.
5. **Deployment secrets:** configure only in the hosting provider's encrypted environment settings. Never place private credentials in `VITE_*` variables or commit them.

## Safe test policy

- Keep this branch separate from `main`.
- Do not merge or promote it to production until CI passes and the release blockers above have an approved implementation.
- Do not use real ad accounts or live budgets during validation. Use sandbox/test accounts and explicit spend caps.


## Supabase email OTP implementation notes

- The browser uses the Supabase client for email OTP and keeps the Supabase session in the SDK-managed session store.
- Protected API requests verify the bearer access token with Supabase Auth and require a confirmed email, a linked `public.users.auth_user_id`, an ACTIVE `public.memberships` row, and a matching organization. App roles are re-read from the server-side membership record.
- `GET /api/organizations` now returns only organizations with an ACTIVE membership for the authenticated user.
- Apply `supabase/migrations/20261021_harden_auth_and_rls.sql` before using this flow. It removes old permissive `USING (true)` policies and revokes browser-role table access.
- Setup and controlled staging account provisioning steps are in `docs/SUPABASE_SETUP.md`.
- This is not a production certification. Full durable tenant data migration and browser E2E remain release gates.


## Customer demo and security-workflow follow-up

- Added a guided Product Demo view with five chapters and an optional hosted video player. Configure `VITE_PRODUCT_DEMO_VIDEO_URL` as a public HTTPS video URL; it is a frontend build variable, not a secret.
- The guided tour labels important boundaries: drafts are not live campaigns, and the current app does not execute live provider-side budget changes. Use sanitized fictional data in any public recording.
- CodeQL can still analyze the code when GitHub code-scanning upload is unavailable. The workflow uploads SARIF only when the repository variable `CODE_SCANNING_ENABLED` is explicitly set to `true`; enable it only after GitHub code scanning is available for this repository. Without upload entitlement, analysis runs but results are not published to the Security tab.
- A passing typecheck/build or a static migration-contract test does not replace staging browser E2E or security review.


## Phase 3: durable finance proposals and review

- Added `supabase/migrations/20261023_durable_finance_workflows.sql` for tenant-scoped proposal records and organization control records.
- Proposal creation and review use service-role-only security-definer RPCs. Membership/role checks, four-eyes review, emergency-stop checks, campaign-version validation, campaign budget updates and audit-event append happen transactionally.
- Stale campaign versions are marked stale; concurrent or already-reviewed proposals return conflicts. Budget approval updates the internal durable draft only and explicitly does not claim a provider-side budget write.
- Vercel finance proposal GET/POST/review routes use the durable repository when Supabase server configuration is present; if the database is not configured or the migration is absent, requests fail closed rather than using ephemeral state.
- Added static migration/repository contract tests. These do not execute SQL against the user's Supabase instance; apply the migration in staging and perform browser E2E before relying on the workflow.
- Added a customer Product Demo view with guided chapters and an optional hosted video player. A narrated video still must be recorded/hosted and configured via `VITE_PRODUCT_DEMO_VIDEO_URL`.
