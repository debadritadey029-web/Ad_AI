-- ==============================================================================
-- AdVantage AI Enterprise Database Schema for Supabase PostgreSQL
-- Compatible with Free Tier Supabase projects
-- ==============================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Organizations Table
CREATE TABLE IF NOT EXISTS public.organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'ENTERPRISE',
  default_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  emergency_stop_active BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_stop_reason TEXT,
  emergency_stop_triggered_at TIMESTAMPTZ,
  emergency_stop_triggered_by TEXT,
  settings JSONB NOT NULL DEFAULT '{
    "budgetChangeApprovalThresholdMinorUnits": 50000,
    "dailySpendCeilingMinorUnits": 200000,
    "monthlySpendCeilingMinorUnits": 5000000,
    "requireFourEyesApproval": true,
    "brandSafetyStrictness": "STRICT"
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Users Table (with Phone & Two-Factor Authentication fields)
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  name TEXT NOT NULL,
  avatar_url TEXT,
  password_hash TEXT,
  password_salt TEXT,
  two_factor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  two_factor_method TEXT NOT NULL DEFAULT 'both' CHECK (two_factor_method IN ('email', 'phone', 'both')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for phone and email lookup
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON public.users(phone);

-- 4. Memberships Table (Tenant Isolation & RBAC)
CREATE TABLE IF NOT EXISTS public.memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'CAMPAIGN_MANAGER' CHECK (role IN (
    'OWNER', 'ADMIN', 'CAMPAIGN_MANAGER', 'ANALYST', 'CREATIVE', 'FINANCE_APPROVER', 'OPERATOR', 'READ_ONLY'
  )),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_org ON public.memberships(user_id, org_id);

-- 5. Two-Step OTP Verification Table
CREATE TABLE IF NOT EXISTS public.otp_codes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  target TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
  code VARCHAR(10) NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('LOGIN_2FA', 'OTP_LOGIN', 'PHONE_VERIFY')),
  user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  attempts INT NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_target ON public.otp_codes(target);

-- 6. Advertising Provider Connections Table
CREATE TABLE IF NOT EXISTS public.provider_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('META_ADS', 'GOOGLE_ADS', 'TIKTOK_ADS', 'LINKEDIN_ADS')),
  external_account_id TEXT NOT NULL,
  external_account_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED', 'DISCONNECTED', 'DEGRADED', 'REVOKED')),
  environment TEXT NOT NULL DEFAULT 'SANDBOX' CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, provider, external_account_id)
);

-- 7. Campaigns Table
CREATE TABLE IF NOT EXISTS public.campaigns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('META_ADS', 'GOOGLE_ADS', 'TIKTOK_ADS', 'LINKEDIN_ADS')),
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED')),
  budget_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  daily_budget_minor_units BIGINT NOT NULL DEFAULT 0,
  lifetime_budget_minor_units BIGINT,
  total_spend_minor_units BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  conversions BIGINT NOT NULL DEFAULT 0,
  roas NUMERIC(8, 2) NOT NULL DEFAULT 0,
  ctr NUMERIC(6, 4) NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_org ON public.campaigns(org_id);

-- 8. Budget Proposals Table (Four-Eyes Financial Governance)
CREATE TABLE IF NOT EXISTS public.budget_proposals (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  proposed_by_user_id TEXT NOT NULL REFERENCES public.users(id),
  current_budget_minor_units BIGINT NOT NULL,
  proposed_budget_minor_units BIGINT NOT NULL,
  change_percentage NUMERIC(6, 2) NOT NULL,
  justification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  reviewed_by_user_id TEXT REFERENCES public.users(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  campaign_version_at_creation INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Creative Assets Table
CREATE TABLE IF NOT EXISTS public.creatives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IMAGE', 'VIDEO', 'CAROUSEL', 'COPY_VARIATION')),
  headline TEXT NOT NULL,
  primary_text TEXT NOT NULL,
  call_to_action TEXT NOT NULL DEFAULT 'Learn More',
  target_url TEXT,
  asset_url TEXT,
  aspect_ratio TEXT NOT NULL DEFAULT '1:1',
  compliance_checked BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Leads Table
CREATE TABLE IF NOT EXISTS public.leads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('WHATSAPP', 'INSTAGRAM', 'FACEBOOK_MESSENGER', 'META_INSTANT_FORM')),
  contact_name TEXT NOT NULL,
  contact_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED')),
  campaign_id TEXT REFERENCES public.campaigns(id) ON DELETE SET NULL,
  last_message_snippet TEXT,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  messaging_window_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  consent_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_to_user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Tamper-Evident Cryptographic Audit Log Table
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_time ON public.audit_logs(org_id, timestamp DESC);

-- ==============================================================================
-- Row Level Security (RLS) Configuration
-- ==============================================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Allow public read/write access via API keys for service execution
CREATE POLICY "Allow service role full access" ON public.organizations FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.users FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.memberships FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.otp_codes FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.provider_connections FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.campaigns FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.budget_proposals FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.creatives FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.leads FOR ALL USING (true);
CREATE POLICY "Allow service role full access" ON public.audit_logs FOR ALL USING (true);

-- ==============================================================================
-- Seed Baseline Data (Enterprise Demo Organizations & Users)
-- ==============================================================================

INSERT INTO public.organizations (id, name, slug, tier, default_currency)
VALUES 
  ('org_apex', 'Apex Global Commerce', 'apex-global', 'ENTERPRISE', 'USD'),
  ('org_velocity', 'Velocity Media Labs', 'velocity-media', 'GROWTH', 'EUR'),
  ('org_solaris', 'Solaris Energy Direct', 'solaris-energy', 'STARTER', 'INR')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, email, phone, name, avatar_url, password_salt, password_hash, two_factor_enabled, two_factor_method)
VALUES 
  ('usr_sarah', 'sarah.jenkins@advantage-ai.enterprise', '+15552345678', 'Sarah Jenkins', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', 'a8f192b03e5c7d2194812a0f8b1c4d5e', '68984da63f2747372cf5ce85150e7b8b211bb1f2ee9b6ae6919fa00bc4fece0702d338f9038221b0e5da815252875b2241b71aa5553e4b77f9cb798da6b9c97b', true, 'both'),
  ('usr_marcus', 'marcus.vance@advantage-ai.enterprise', '+15553456789', 'Marcus Vance', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150', 'a8f192b03e5c7d2194812a0f8b1c4d5e', '68984da63f2747372cf5ce85150e7b8b211bb1f2ee9b6ae6919fa00bc4fece0702d338f9038221b0e5da815252875b2241b71aa5553e4b77f9cb798da6b9c97b', true, 'phone'),
  ('usr_priya', 'priya.sharma@advantage-ai.enterprise', '+919876543210', 'Priya Sharma', 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150', 'a8f192b03e5c7d2194812a0f8b1c4d5e', '68984da63f2747372cf5ce85150e7b8b211bb1f2ee9b6ae6919fa00bc4fece0702d338f9038221b0e5da815252875b2241b71aa5553e4b77f9cb798da6b9c97b', true, 'email')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.memberships (id, user_id, org_id, role, status)
VALUES 
  ('mem_sarah_apex', 'usr_sarah', 'org_apex', 'OWNER', 'ACTIVE'),
  ('mem_marcus_apex', 'usr_marcus', 'org_apex', 'ADMIN', 'ACTIVE'),
  ('mem_priya_apex', 'usr_priya', 'org_apex', 'CAMPAIGN_MANAGER', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;
