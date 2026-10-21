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
