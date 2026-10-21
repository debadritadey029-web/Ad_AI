# Supabase email OTP setup for AdVantage AI

This branch adds a Supabase email OTP sign-in path and server-side access-token validation. The API also requires an explicitly provisioned user and ACTIVE organization membership. This is still a staging implementation: the app's campaign/finance data store remains a process-local map plus whole-state snapshot, so do not use real customer data or live ad accounts yet.

## 1. Apply the database hardening migration

In Supabase Dashboard → SQL Editor, run the file:

`supabase/migrations/20261021_harden_auth_and_rls.sql`

It adds the `auth_user_id` link on `public.users`, removes old unrestricted RLS policies, and revokes direct table access from browser roles. The server-side service-role client is used for these lookups; never expose that key to the browser.

If you have not already run the base schema, apply `supabase/schema.sql` first, then run the hardening migration. Review the SQL before executing it.

## 2. Configure Supabase Auth

1. In Authentication → Providers → Email, enable email sign-in.
2. In Authentication → URL Configuration, set the Site URL to your staging URL and add the exact staging URL and localhost URL to allowed redirect URLs if needed.
3. Configure custom SMTP in Authentication → SMTP Settings for reliable email delivery.
4. In Authentication → Email Templates, ensure the email OTP template displays the numeric token using `{{ .Token }}`; the app expects a six-digit code, not only a magic-link button.
5. In Authentication → Rate Limits, retain rate limiting and choose conservative OTP limits.
6. Create/invite tester accounts under Authentication → Users. Testers must use an email they can access. Confirm the email before sign-in; this app deliberately does not auto-create app accounts from arbitrary email addresses.

The current UI uses email OTP. SMS OTP and password + second factor are not part of this Supabase flow yet.

## 3. Provision a staging organization and owner

After creating the tester in Authentication → Users, copy their **User UID**. In SQL Editor, replace the three quoted placeholders below with the Auth user's UUID, email, and display name, then run the script. It creates a new staging organization, a linked app user, and an OWNER membership.

```sql
DO $$
DECLARE
  v_auth_user_id uuid := 'REPLACE_WITH_AUTH_USER_UID'::uuid;
  v_email text := lower('REPLACE_WITH_CONFIRMED_EMAIL');
  v_name text := 'REPLACE_WITH_DISPLAY_NAME';
  v_org_id text := 'org_' || replace(gen_random_uuid()::text, '-', '');
  v_user_id text := 'usr_' || replace(gen_random_uuid()::text, '-', '');
  v_slug text := 'staging-' || replace(gen_random_uuid()::text, '-', '');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = v_auth_user_id
      AND lower(email) = v_email
      AND email_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Auth user not found, email mismatch, or email not confirmed';
  END IF;

  INSERT INTO public.organizations
    (id, name, slug, tier, default_currency, settings)
  VALUES
    (v_org_id, 'AdVantage AI Staging', v_slug, 'STARTER', 'INR',
     jsonb_build_object(
       'budgetChangeApprovalThresholdMinorUnits', 50000,
       'dailySpendCeilingMinorUnits', 200000,
       'monthlySpendCeilingMinorUnits', 5000000,
       'requireFourEyesApproval', true,
       'brandSafetyStrictness', 'STRICT'
     ));

  INSERT INTO public.users
    (id, email, name, auth_user_id, two_factor_enabled, two_factor_method)
  VALUES
    (v_user_id, v_email, v_name, v_auth_user_id, true, 'email');

  INSERT INTO public.memberships
    (id, user_id, org_id, role, status)
  VALUES
    ('mem_' || replace(gen_random_uuid()::text, '-', ''),
     v_user_id, v_org_id, 'OWNER', 'ACTIVE');
END $$;
```

Repeat with a different organization and user for each isolated test tenant. Do not assign OWNER unless the person is meant to administer that organization. The app checks the Supabase Auth UID, confirmed email, application user row, active membership, role, and organization before serving protected API routes.

## 4. Configure Vercel runtime environment variables

Add these under Vercel → Project → Settings → Environment Variables, for **Preview** first. Redeploy after saving.

- `VITE_SUPABASE_URL`: Supabase Project URL.
- `VITE_SUPABASE_ANON_KEY`: Supabase publishable/anon key; this is public and relies on RLS.
- `SUPABASE_URL`: same Project URL, server-side.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service-role key, server-only; never use a `VITE_` prefix.
- `APP_ENV=staging` in Preview only.
- `ENABLE_DEMO_AUTH=false` and `ENABLE_DEV_OTP_CODE=false`.

For Vercel Production, set `APP_ENV=production`, `ENABLE_DEMO_AUTH=false`, and `ENABLE_DEV_OTP_CODE=false`. GitHub Actions repository secrets do **not** automatically become Vercel runtime environment variables; set the runtime values in Vercel's environment settings as well. Never paste secrets into chat, source files, or screenshots.

## 5. Verify staging

1. Open the Vercel Preview deployment and use email OTP with the provisioned address.
2. Confirm the app opens only after OTP verification.
3. Try the same email without an active membership; the API should deny access.
4. Sign in as users from two different test organizations and confirm the organization list and data remain isolated.
5. Check the Vercel logs for server errors and run the repository CI tests before promoting any build.

## Remaining release blockers

- Campaign, budget, lead, creative, provider-connection, and audit data are still held in an in-memory store and snapshot. This is not safe for concurrent Vercel serverless instances; migrate them to transactional tenant-scoped tables.
- Add comprehensive tests for Supabase token expiry/revocation, invitation and membership lifecycle, cross-tenant access, and role changes.
- Real ad-provider OAuth/publishing, budget writes, pausing, and provider-side verification are not implemented. Never use live budgets during this stage.
- Browser E2E tests must be run against a dedicated staging project before production release.
