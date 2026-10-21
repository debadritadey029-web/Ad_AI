/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { globalStore, persistCurrentStore } from './db/store.js';
import {
  evaluateBudgetPolicy,
  toMinorUnits,
  fromMinorUnits,
  formatCurrency,
  calculateMarketingMetrics,
} from './services/finance.js';
import { hasPermission, canRemoveMember, ROLE_PERMISSIONS } from './services/rbac.js';
import { createAuditLogEntry, verifyAuditChain } from './services/audit.js';
import { askCopilot } from './services/copilot.js';
import {
  PROVIDER_CATALOG,
  validateCreativeForProvider,
  validateCampaignMinBudget,
} from './services/providers/index.js';
import {
  createSession,
  validateSessionToken,
  revokeSession,
  extractAuthToken,
  verifyPassword,
  sendOtp,
  verifyOtp,
  createTwoFactorChallenge,
  verifyTwoFactorChallenge,
  normalizePhone,
  maskContact,
} from './services/auth.js';
import { getSupabaseServerStatus, testSupabaseConnection, resolveSupabaseProvisionedIdentity } from './db/supabase.js';
import {
  CampaignRepositoryError,
  isDurableCampaignPersistenceEnabled,
  listCampaignsForOrganization,
  createDurableCampaign,
  updateDurableCampaignStatus,
} from './db/campaign-repository.js';
import {
  isDurableFinancePersistenceEnabled,
  listDurableProposals,
  getDurableCampaignForFinance,
  createDurableBudgetProposal,
  reviewDurableBudgetProposal,
  setDurableEmergencyStop,
} from './db/finance-repository.js';
import { createRateLimiter } from './middleware/security.js';
import { isDemoAuthEnabled, isProduction, shouldExposeDevOtpCode } from './services/security-mode.js';
import {
  Campaign,
  BudgetProposal,
  CreativeAsset,
  LeadRecord,
  User,
  Organization,
  Membership,
  Session,
  ProviderType,
  CampaignStatus,
} from './db/types.js';

export const apiRouter = Router();

// Rate limiters for sensitive endpoints
const authLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
const copilotLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 25 });

// Extend Express Request for context
export interface ContextRequest extends Request {
  user?: User;
  org?: Organization;
  membership?: Membership;
  session?: Session;
  token?: string;
}

/**
 * Middleware that resolves the authenticated user, session, and tenant organization.
 * Requires a valid session token for every non-public route.
 */
async function resolveContext(req: ContextRequest, res: Response, next: NextFunction) {
  const publicPaths = [
    '/health',
    '/health/ready',
    '/supabase/status',
    '/auth/login',
    '/auth/login-step1',
    '/auth/login-step2',
    '/auth/otp/send',
    '/auth/otp/verify',
    '/auth/demo-login',
  ];
  if (publicPaths.some((p) => req.path.endsWith(p) || req.path === p)) return next();

  const token = extractAuthToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHENTICATED',
      message: 'Authentication required. Please sign in to continue.',
    });
  }

  const session = validateSessionToken(token);
  let user: User | undefined;
  let org: Organization | undefined;
  let membership: Membership | undefined;

  if (session) {
    user = globalStore.users.get(session.userId);
    if (!user) {
      return res.status(401).json({ error: 'USER_NOT_FOUND', message: 'User does not exist.' });
    }

    const requestedOrgId = (req.headers['x-organization-id'] as string) || session.activeOrgId;
    org = globalStore.organizations.get(requestedOrgId);
    if (!org) {
      return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found.' });
    }
    membership = Array.from(globalStore.memberships.values()).find(
      (m) => m.userId === user!.id && m.orgId === org!.id && m.status === 'ACTIVE'
    );
  } else {
    // Supabase Auth access tokens are verified remotely with Supabase Auth.
    // The matching app user and ACTIVE membership must also be explicitly provisioned
    // in Supabase's application tables and mirrored in the application store.
    const requestedOrgId = req.headers['x-organization-id'] as string | undefined;
    const identity = await resolveSupabaseProvisionedIdentity(token, requestedOrgId);
    if (!identity) {
      return res.status(401).json({
        error: 'INVALID_OR_UNPROVISIONED_SUPABASE_SESSION',
        message: 'Your Supabase session is invalid or your account has no active AdVantage AI organization membership.',
      });
    }

    const provisionedUser = identity.appUser;
    user = globalStore.users.get(provisionedUser.id);
    if (user && user.email.trim().toLowerCase() !== identity.email) {
      return res.status(403).json({
        error: 'APP_ACCOUNT_EMAIL_MISMATCH',
        message: 'The signed-in email does not match the provisioned AdVantage AI account.',
      });
    }
    if (!user) {
      user = {
        id: provisionedUser.id,
        email: provisionedUser.email,
        name: provisionedUser.name,
        phone: provisionedUser.phone,
        avatarUrl: provisionedUser.avatarUrl,
        createdAt: provisionedUser.createdAt,
      };
      globalStore.users.set(user.id, user);
    }

    const provisionedOrg = identity.organization;
    org = globalStore.organizations.get(provisionedOrg.id);
    if (!org) {
      const settings = provisionedOrg.settings || {};
      org = {
        id: provisionedOrg.id,
        name: provisionedOrg.name,
        slug: provisionedOrg.slug,
        tier: (['ENTERPRISE', 'GROWTH', 'STARTER'].includes(provisionedOrg.tier) ? provisionedOrg.tier : 'STARTER') as Organization['tier'],
        defaultCurrency: provisionedOrg.defaultCurrency,
        emergencyStopActive: provisionedOrg.emergencyStopActive,
        emergencyStopReason: provisionedOrg.emergencyStopReason,
        emergencyStopTriggeredAt: provisionedOrg.emergencyStopTriggeredAt,
        emergencyStopTriggeredBy: provisionedOrg.emergencyStopTriggeredBy,
        settings: {
          budgetChangeApprovalThresholdMinorUnits: Number(settings.budgetChangeApprovalThresholdMinorUnits ?? 50000),
          dailySpendCeilingMinorUnits: Number(settings.dailySpendCeilingMinorUnits ?? 200000),
          monthlySpendCeilingMinorUnits: Number(settings.monthlySpendCeilingMinorUnits ?? 5000000),
          requireFourEyesApproval: settings.requireFourEyesApproval !== false,
          brandSafetyStrictness: (['STRICT', 'STANDARD', 'LENIENT'].includes(String(settings.brandSafetyStrictness)) ? settings.brandSafetyStrictness : 'STRICT') as Organization['settings']['brandSafetyStrictness'],
        },
        createdAt: provisionedOrg.createdAt,
      };
      globalStore.organizations.set(org.id, org);
    }

    const provisionedMembership = identity.membership;
    membership = Array.from(globalStore.memberships.values()).find(
      (m) => m.userId === user!.id && m.orgId === provisionedMembership.orgId
    );
    if (!membership) {
      membership = {
        id: provisionedMembership.id,
        userId: provisionedMembership.userId,
        orgId: provisionedMembership.orgId,
        role: provisionedMembership.role as Membership['role'],
        status: 'ACTIVE',
        joinedAt: provisionedMembership.joinedAt,
      };
      globalStore.memberships.set(membership.id, membership);
    } else {
      // The server-side database membership is authoritative for role and active status.
      membership.role = provisionedMembership.role as Membership['role'];
      membership.status = 'ACTIVE';
    }
  }

  if (!org) {
    return res.status(404).json({
      error: 'ORGANIZATION_NOT_FOUND',
      message: 'The selected organization is not available in this application environment.',
    });
  }
  if (!membership) {
    return res.status(403).json({
      error: 'TENANT_ACCESS_DENIED',
      message: 'No matching active organization membership is available. Cross-tenant access is prohibited.',
    });
  }

  req.user = user;
  req.org = org;
  req.membership = membership;
  req.session = session || undefined;
  req.token = token;
  return next();
}

// Apply authentication and tenant context before applying write availability gates.
apiRouter.use(resolveContext);

// In Vercel, block writes to domains that have not yet been migrated to durable
// transactional repositories. Never acknowledge a process-local mutation as durable.
apiRouter.use((req: ContextRequest, res: Response, next: NextFunction) => {
  if (!process.env.VERCEL || req.path.startsWith('/auth/')) return next();

  // Do not expose seeded process-local records as if they were customer data.
  // These read models are not yet backed by tenant-scoped durable repositories.
  const durableReadRequired = new Set([
    '/providers', '/analytics', '/creatives', '/leads', '/audit',
  ]);
  if (req.method === 'GET' && req.path === '/finance/proposals' && isDurableFinancePersistenceEnabled()) {
    return next();
  }
  if (req.method === 'GET' && (req.path === '/finance/proposals' || durableReadRequired.has(req.path))) {
    return res.status(503).json({
      error: 'DURABLE_PERSISTENCE_NOT_IMPLEMENTED',
      message: 'This data view is temporarily unavailable in serverless staging until its tenant-scoped durable repository is deployed. No demo snapshot data is returned.',
    });
  }

  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const durableCampaignWrite =
    (req.method === 'POST' && req.path === '/campaigns') ||
    (req.method === 'PATCH' && /^\/campaigns\/[^/]+\/status$/.test(req.path));
  const durableFinanceWrite =
    (req.method === 'POST' && req.path === '/finance/proposals') ||
    (req.method === 'POST' && req.path === '/finance/emergency-stop') ||
    (req.method === 'POST' && /^\/finance\/proposals\/[^/]+\/review$/.test(req.path));
  if (durableCampaignWrite && !isDurableCampaignPersistenceEnabled()) {
    return res.status(503).json({
      error: 'DURABLE_CAMPAIGN_STORAGE_NOT_CONFIGURED',
      message: 'Campaign writes are disabled on Vercel until Supabase durable persistence is configured. No change was applied.',
    });
  }
  if (durableFinanceWrite && isDurableFinancePersistenceEnabled()) return next();
  if (durableCampaignWrite) return next();
  return res.status(503).json({
    error: 'DURABLE_PERSISTENCE_NOT_IMPLEMENTED',
    message: 'This write is temporarily disabled in serverless staging until its tenant-scoped transactional repository is deployed. No change was applied.',
  });
});

// ---------------------------------------------------------------------------
// 1. Two-Step Authentication & OTP Endpoints (Email & Phone)
// ---------------------------------------------------------------------------

/**
 * Step 1: Initiates OTP code transmission to Email or Phone number
 */
apiRouter.post('/auth/otp/send', authLimiter, (req: Request, res: Response) => {
  const { target, channel = 'email' } = req.body;
  if (!target || typeof target !== 'string' || !target.trim()) {
    return res.status(400).json({ error: 'TARGET_REQUIRED', message: 'Email or phone number is required.' });
  }

  const effectiveChannel: 'email' | 'phone' =
    channel === 'phone' || (!target.includes('@') && /[\d+]/.test(target)) ? 'phone' : 'email';

  if (effectiveChannel === 'email' && !target.includes('@')) {
    return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Please enter a valid email address.' });
  }

  if (effectiveChannel === 'phone') {
    const digits = target.replace(/[^\d]/g, '');
    if (digits.length < 8) {
      return res.status(400).json({ error: 'INVALID_PHONE', message: 'Please enter a valid phone number with country code.' });
    }
  }

  // No email/SMS adapter exists yet. Only allow the explicit development-code path in
  // isolated non-production environments; otherwise do not claim delivery succeeded.
  if (isProduction() || !shouldExposeDevOtpCode()) {
    return res.status(503).json({
      error: 'OTP_DELIVERY_NOT_CONFIGURED',
      message: 'Secure email/SMS delivery is not configured. OTP sign-in is unavailable unless development OTP codes are explicitly enabled in isolated staging.',
    });
  }

  const result = sendOtp({
    target,
    channel: effectiveChannel,
    purpose: 'OTP_LOGIN',
  });

  res.json({
    success: true,
    message: result.message,
    channel: result.channel,
    targetMasked: result.targetMasked,
    expiresInSeconds: result.expiresInSeconds,
    ...(shouldExposeDevOtpCode() && result.devCode ? { devCode: result.devCode } : {}),
  });
});

/**
 * Step 2: Verifies 6-digit OTP code and creates authenticated session
 */
apiRouter.post('/auth/otp/verify', authLimiter, (req: Request, res: Response) => {
  const { target, code, channel, name } = req.body;
  if (!target || !code) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Target (email/phone) and 6-digit code are required.' });
  }
  if (isProduction()) {
    return res.status(503).json({ error: 'OTP_DELIVERY_NOT_CONFIGURED', message: 'OTP verification is unavailable until secure email/SMS delivery is configured.' });
  }

  const effectiveChannel: 'email' | 'phone' =
    channel === 'phone' || (!target.includes('@') && /[\d+]/.test(target)) ? 'phone' : 'email';

  const verification = verifyOtp({
    target,
    code,
    channel: effectiveChannel,
    purpose: 'OTP_LOGIN',
  });

  if (!verification.success) {
    return res.status(400).json({ error: verification.error, message: verification.message });
  }

  // Find or register user
  const normalizedTarget =
    effectiveChannel === 'phone'
      ? normalizePhone(target)
      : target.trim().toLowerCase();

  let user = Array.from(globalStore.users.values()).find((u) => {
    if (effectiveChannel === 'email') {
      return u.email.toLowerCase() === normalizedTarget;
    } else {
      return u.phone && normalizePhone(u.phone) === normalizedTarget;
    }
  });

  if (!user) {
    return res.status(403).json({
      error: 'ACCOUNT_NOT_PROVISIONED',
      message: 'This destination is not registered. Ask your organization administrator for an invitation.',
    });
  }

  // Find active org
  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === user!.id && m.status === 'ACTIVE'
  );
  if (!membership) {
    return res.status(403).json({ error: 'ORGANIZATION_MEMBERSHIP_REQUIRED', message: 'No active organization membership is assigned to this account.' });
  }
  const orgId = membership.orgId;

  const session = createSession({
    userId: user.id,
    activeOrgId: orgId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] || 'AdVantage-OTP-Client',
  });

  persistCurrentStore();

  res.json({
    success: true,
    token: session.token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorMethod: user.twoFactorMethod,
    },
    activeOrgId: orgId,
    org: globalStore.organizations.get(orgId),
    membership,
    message: 'Authenticated successfully with 2-step OTP verification.',
  });
});

/**
 * Two-Step Login Step 1: Verify Email + Password, then trigger 2FA challenge
 */
apiRouter.post('/auth/login-step1', authLimiter, (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (isProduction()) {
    return res.status(503).json({ error: 'SECURE_LOGIN_NOT_CONFIGURED', message: 'Production sign-in is unavailable until secure two-factor delivery is configured.' });
  }

  const user = Array.from(globalStore.users.values()).find(
    (u) => u.email.toLowerCase() === String(email).toLowerCase()
  );

  if (!user || !user.passwordSalt || !user.passwordHash) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  }

  const valid = verifyPassword(password, user.passwordSalt, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  }

  // Check if 2FA is enabled (true for all enterprise users by default)
  if (user.twoFactorEnabled !== false) {
    // No delivery adapter exists yet. Only allow explicitly enabled staging OTP codes.
    if (isProduction() || !shouldExposeDevOtpCode()) {
      return res.status(503).json({
        error: 'OTP_DELIVERY_NOT_CONFIGURED',
        message: 'Secure email/SMS delivery is not configured. Two-factor sign-in is unavailable unless development OTP codes are explicitly enabled in isolated staging.',
      });
    }
    const channel: 'email' | 'phone' =
      user.twoFactorMethod === 'phone' && user.phone ? 'phone' : 'email';
    const target = channel === 'phone' && user.phone ? user.phone : user.email;

    const challenge = createTwoFactorChallenge({
      userId: user.id,
      target,
      channel,
    });

    return res.json({
      requires2FA: true,
      challengeToken: challenge.challengeToken,
      targetMasked: challenge.targetMasked,
      channel,
      ...(shouldExposeDevOtpCode() && challenge.devCode ? { devCode: challenge.devCode } : {}),
      message: `Credentials verified. Two-step verification code sent to ${challenge.targetMasked}.`,
    });
  }

  // Fallback direct login if 2FA explicitly disabled
  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === user.id && m.status === 'ACTIVE'
  );
  if (!membership) {
    return res.status(403).json({ error: 'ORGANIZATION_MEMBERSHIP_REQUIRED', message: 'No active organization membership is assigned to this account.' });
  }
  const orgId = membership.orgId;

  const session = createSession({
    userId: user.id,
    activeOrgId: orgId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  persistCurrentStore();

  res.json({
    requires2FA: false,
    success: true,
    token: session.token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorMethod: user.twoFactorMethod,
    },
    activeOrgId: orgId,
  });
});

/**
 * Two-Step Login Step 2: Verify challenge token + OTP code
 */
apiRouter.post('/auth/login-step2', authLimiter, (req: Request, res: Response) => {
  const { challengeToken, code } = req.body;
  if (isProduction()) {
    return res.status(503).json({ error: 'SECURE_LOGIN_NOT_CONFIGURED', message: 'Production sign-in is unavailable until secure two-factor delivery is configured.' });
  }
  if (!challengeToken || !code) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Challenge token and 6-digit OTP code are required.' });
  }

  const result = verifyTwoFactorChallenge({
    challengeToken,
    code,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  if (!result.success || !result.session || !result.user) {
    return res.status(400).json({ error: result.error || 'INVALID_CODE', message: result.message || 'Verification failed.' });
  }

  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === result.user!.id && m.status === 'ACTIVE'
  );
  if (!membership) {
    return res.status(403).json({ error: 'ORGANIZATION_MEMBERSHIP_REQUIRED', message: 'No active organization membership is assigned to this account.' });
  }
  const orgId = membership.orgId;

  persistCurrentStore();

  res.json({
    success: true,
    token: result.session.token,
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      phone: result.user.phone,
      avatarUrl: result.user.avatarUrl,
      twoFactorEnabled: result.user.twoFactorEnabled,
      twoFactorMethod: result.user.twoFactorMethod,
    },
    activeOrgId: orgId,
    message: 'Two-step verification completed. Logged in successfully.',
  });
});

/**
 * Update 2FA Security Settings for authenticated user
 */
apiRouter.post('/auth/2fa/settings', (req: ContextRequest, res: Response) => {
  const { enabled, method, phone } = req.body;
  const user = req.user!;

  if (typeof enabled === 'boolean') {
    user.twoFactorEnabled = enabled;
  }
  if (method === 'email' || method === 'phone' || method === 'both') {
    user.twoFactorMethod = method;
  }
  if (typeof phone === 'string' && phone.trim()) {
    user.phone = normalizePhone(phone);
  }

  persistCurrentStore();

  res.json({
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorMethod: user.twoFactorMethod,
    },
    message: 'Security settings updated successfully.',
  });
});

/**
 * Supabase Connection & Health Status
 */
apiRouter.get('/supabase/status', (req: Request, res: Response) => {
  res.json(getSupabaseServerStatus());
});

apiRouter.post('/supabase/test', async (req: Request, res: Response) => {
  const result = await testSupabaseConnection();
  res.json(result);
});

apiRouter.post('/auth/login', authLimiter, (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (isProduction()) {
    return res.status(503).json({ error: 'SECURE_LOGIN_NOT_CONFIGURED', message: 'Production sign-in is unavailable until secure two-factor delivery is configured.' });
  }

  const user = Array.from(globalStore.users.values()).find(
    (u) => u.email.toLowerCase() === String(email).toLowerCase()
  );

  if (!user || !user.passwordSalt || !user.passwordHash) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  }

  const valid = verifyPassword(password, user.passwordSalt, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  }

  // This legacy endpoint skips the 2FA challenge, so it is restricted to accounts
  // that explicitly have 2FA disabled and is never used in production.
  if (user.twoFactorEnabled !== false) {
    return res.status(403).json({
      error: 'TWO_FACTOR_REQUIRED',
      message: 'This account requires two-factor verification. Use the two-step sign-in flow.',
    });
  }

  // Find first active organization
  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === user.id && m.status === 'ACTIVE'
  );
  if (!membership) {
    return res.status(403).json({ error: 'ORGANIZATION_MEMBERSHIP_REQUIRED', message: 'No active organization membership is assigned to this account.' });
  }
  const orgId = membership.orgId;

  const session = createSession({
    userId: user.id,
    activeOrgId: orgId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  persistCurrentStore();

  res.json({
    success: true,
    token: session.token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, avatarUrl: user.avatarUrl },
    activeOrgId: orgId,
  });
});

apiRouter.post('/auth/demo-login', (req: Request, res: Response) => {
  if (!isDemoAuthEnabled()) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Demo sign-in is disabled.' });
  }
  const { userId, orgId } = req.body;
  if (!userId || !globalStore.users.has(userId)) {
    return res.status(400).json({ error: 'Invalid userId.' });
  }

  const targetOrgId = orgId || 'org_apex';
  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === userId && m.orgId === targetOrgId && m.status === 'ACTIVE'
  );

  if (!membership) {
    return res.status(403).json({
      error: 'TENANT_ACCESS_DENIED',
      message: 'Selected user is not a member of the requested organization.',
    });
  }

  const session = createSession({
    userId,
    activeOrgId: targetOrgId,
    ipAddress: req.ip,
    userAgent: 'AdVantage-Demo-Switcher',
  });

  persistCurrentStore();

  res.json({
    success: true,
    token: session.token,
    user: (() => {
      const selectedUser = globalStore.users.get(userId)!;
      return { id: selectedUser.id, name: selectedUser.name, email: selectedUser.email, phone: selectedUser.phone, avatarUrl: selectedUser.avatarUrl };
    })(),
    org: globalStore.organizations.get(targetOrgId),
    membership,
  });
});

apiRouter.post('/auth/logout', (req: ContextRequest, res: Response) => {
  if (req.token) {
    revokeSession(req.token);
    persistCurrentStore();
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

apiRouter.get('/auth/context', (req: ContextRequest, res: Response) => {
  const user = req.user!;
  const org = req.org!;
  const membership = req.membership!;

  // Return only the signed-in user's own profile and organizations they are authorized to access.
  const allUsers = isDemoAuthEnabled()
    ? Array.from(globalStore.users.values()).map((u) => ({
        id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl,
      }))
    : [{ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl }];
  const allOrgs = Array.from(globalStore.memberships.values())
    .filter((m) => m.userId === user.id && m.status === 'ACTIVE')
    .map((m) => globalStore.organizations.get(m.orgId))
    .filter((o): o is Organization => Boolean(o));
  const userMemberships = Array.from(globalStore.memberships.values()).filter(
    (m) => m.userId === user.id
  );

  res.json({
    user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
    currentOrg: org,
    membership,
    permissions: ROLE_PERMISSIONS[membership.role] || [],
    availableUsers: allUsers,
    availableOrgs: allOrgs,
    userMemberships,
  });
});

apiRouter.post('/auth/switch-context', (req: ContextRequest, res: Response) => {
  const { userId, orgId } = req.body;
  const user = req.user!;
  const session = req.session!;

  // User impersonation is available only in explicitly enabled local/demo mode.
  if (userId && userId !== user.id && !isDemoAuthEnabled()) {
    return res.status(403).json({ error: 'DEMO_SWITCH_DISABLED', message: 'Switching user identities is disabled.' });
  }
  if (userId && userId !== user.id) {
    return res.status(403).json({ error: 'DEMO_SWITCH_UNSUPPORTED', message: 'Sign in as the intended demo user instead.' });
  }
  if (typeof orgId !== 'string' || !orgId.trim()) {
    return res.status(400).json({ error: 'ORGANIZATION_REQUIRED', message: 'An organization ID is required.' });
  }

  const org = globalStore.organizations.get(orgId);
  if (!org) return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found.' });
  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === user.id && m.orgId === org.id && m.status === 'ACTIVE'
  );
  if (!membership) {
    return res.status(403).json({ error: 'TENANT_ACCESS_DENIED', message: 'You do not have active membership in that organization.' });
  }

  // Supabase access-token sessions are stateless; tenant selection is supplied
  // per request and revalidated by resolveContext. Legacy sessions may persist it.
  if (session) {
    session.activeOrgId = org.id;
    persistCurrentStore();
  }
  res.json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
    currentOrg: org,
    membership,
    permissions: ROLE_PERMISSIONS[membership.role] || [],
  });
});

// ---------------------------------------------------------------------------
// 2. Organizations
// ---------------------------------------------------------------------------

apiRouter.get('/organizations', (req: ContextRequest, res: Response) => {
  const userId = req.user!.id;
  const visibleOrganizations = Array.from(globalStore.memberships.values())
    .filter((membership) => membership.userId === userId && membership.status === 'ACTIVE')
    .map((membership) => globalStore.organizations.get(membership.orgId))
    .filter((organization): organization is Organization => Boolean(organization));
  res.json(visibleOrganizations);
});

apiRouter.patch('/organizations/settings', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;

  if (!hasPermission(membership.role, 'MANAGE_ORGS')) {
    return res.status(403).json({ error: 'Permission denied: Requires MANAGE_ORGS permission.' });
  }

  const {
    budgetApprovalThresholdMinorUnits,
    dailySpendCeilingMinorUnits,
    requireFourEyesApproval,
    brandSafetyStrictness,
  } = req.body;

  if (budgetApprovalThresholdMinorUnits !== undefined) {
    const val = Number(budgetApprovalThresholdMinorUnits);
    if (isNaN(val) || val <= 0) {
      return res.status(400).json({ error: 'Threshold must be a positive number.' });
    }
    org.settings.budgetChangeApprovalThresholdMinorUnits = Math.round(val);
  }
  if (dailySpendCeilingMinorUnits !== undefined) {
    const val = Number(dailySpendCeilingMinorUnits);
    if (isNaN(val) || val <= 0) {
      return res.status(400).json({ error: 'Daily spend ceiling must be a positive number.' });
    }
    org.settings.dailySpendCeilingMinorUnits = Math.round(val);
  }
  if (requireFourEyesApproval !== undefined) {
    org.settings.requireFourEyesApproval = Boolean(requireFourEyesApproval);
  }
  if (brandSafetyStrictness) {
    org.settings.brandSafetyStrictness = brandSafetyStrictness;
  }

  // Audit log
  const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
  const log = createAuditLogEntry({
    orgId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    actorRole: membership.role,
    action: 'ORGANIZATION_SETTINGS_UPDATED',
    entityType: 'ORGANIZATION',
    entityId: org.id,
    prevHash: prevLog?.hash,
    details: req.body,
  });
  globalStore.auditLogs.push(log);
  persistCurrentStore();

  res.json({ success: true, org });
});

// ---------------------------------------------------------------------------
// 3. Campaigns
// ---------------------------------------------------------------------------

apiRouter.get('/campaigns', async (req: ContextRequest, res: Response) => {
  const org = req.org!;
  if (isDurableCampaignPersistenceEnabled()) {
    try {
      return res.json(await listCampaignsForOrganization(org.id));
    } catch (error) {
      console.error('[CampaignRepository] list failed', error instanceof CampaignRepositoryError ? error.code : 'UNEXPECTED_ERROR');
      return res.status(503).json({
        error: 'DURABLE_CAMPAIGN_STORAGE_UNAVAILABLE',
        message: 'Campaign data could not be loaded from durable storage. Please retry; no local snapshot fallback was used.',
      });
    }
  }
  const campaigns = Array.from(globalStore.campaigns.values()).filter((c) => c.orgId === org.id);
  return res.json(campaigns);
});

apiRouter.post('/campaigns', async (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;

  if (!hasPermission(membership.role, 'CREATE_CAMPAIGNS')) {
    return res.status(403).json({ error: 'Permission denied: Requires CREATE_CAMPAIGNS permission.' });
  }

  if (org.emergencyStopActive) {
    return res.status(403).json({
      error: 'EMERGENCY_STOP_ACTIVE: All campaign creation is locked while Emergency Stop is engaged.',
    });
  }

  const {
    name,
    provider,
    providerAccountId,
    objective,
    budgetType,
    budgetAmount,
    currency,
    startDate,
    endDate,
    targeting,
  } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Campaign name is required.' });
  }
  if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, provider)) {
    return res.status(400).json({ error: 'INVALID_PROVIDER', message: 'Select a supported advertising provider.' });
  }

  if (!budgetAmount || isNaN(Number(budgetAmount)) || Number(budgetAmount) <= 0) {
    return res.status(400).json({ error: 'Valid positive budget amount is required.' });
  }

  const validObjectives = ['AWARENESS', 'TRAFFIC', 'ENGAGEMENT', 'LEADS', 'APP_PROMOTION', 'CONVERSIONS'];
  const selectedObjective = objective || 'CONVERSIONS';
  if (typeof selectedObjective !== 'string' || !validObjectives.includes(selectedObjective)) {
    return res.status(400).json({ error: 'INVALID_CAMPAIGN_OBJECTIVE', message: 'Select a supported campaign objective.' });
  }
  const selectedBudgetType = budgetType || 'DAILY';
  if (selectedBudgetType !== 'DAILY' && selectedBudgetType !== 'LIFETIME') {
    return res.status(400).json({ error: 'INVALID_BUDGET_TYPE', message: 'Budget type must be DAILY or LIFETIME.' });
  }

  const campCurrency = String(currency || org.defaultCurrency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(campCurrency)) {
    return res.status(400).json({ error: 'INVALID_CURRENCY', message: 'Currency must be a valid three-letter ISO currency code.' });
  }
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: campCurrency });
  } catch {
    return res.status(400).json({ error: 'INVALID_CURRENCY', message: 'Currency must be a supported ISO currency code.' });
  }

  const parsedStartDate = new Date(startDate || Date.now());
  const parsedEndDate = endDate ? new Date(endDate) : undefined;
  if (Number.isNaN(parsedStartDate.getTime()) || (parsedEndDate && Number.isNaN(parsedEndDate.getTime()))) {
    return res.status(400).json({ error: 'INVALID_CAMPAIGN_DATES', message: 'Start and end dates must be valid dates.' });
  }
  if (parsedEndDate && parsedEndDate < parsedStartDate) {
    return res.status(400).json({ error: 'INVALID_CAMPAIGN_DATES', message: 'End date cannot be earlier than start date.' });
  }

  const budgetMinorUnits = toMinorUnits(Number(budgetAmount), campCurrency);

  // Validate provider minimum budget
  const minValidation = validateCampaignMinBudget(provider as ProviderType, budgetMinorUnits, campCurrency);
  if (!minValidation.valid) {
    return res.status(400).json({ error: minValidation.error });
  }

  // Check against org daily ceiling
  if (budgetMinorUnits > org.settings.dailySpendCeilingMinorUnits) {
    return res.status(400).json({
      error: `Budget exceeds organization daily ceiling of ${formatCurrency(org.settings.dailySpendCeilingMinorUnits, campCurrency)}.`,
    });
  }

  const id = `cmp_${provider}_${randomUUID()}`;
  const newCampaign: Campaign = {
    id,
    orgId: org.id,
    provider: provider as ProviderType,
    providerAccountId: providerAccountId || 'unlinked',
    name: name.trim(),
    objective: selectedObjective as Campaign['objective'],
    // Creating a local record does not publish it to an advertising platform.
    status: 'DRAFT',
    budgetType: selectedBudgetType,
    budgetMinorUnits,
    currency: campCurrency,
    startDate: parsedStartDate.toISOString(),
    endDate: parsedEndDate?.toISOString(),
    targeting: targeting || {
      locations: ['United States'],
      ageMin: 18,
      ageMax: 65,
      genders: ['ALL'],
    },
    adGroupCount: 1,
    creativeIds: [],
    actualSpendMinorUnits: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    revenueMinorUnits: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };

  if (isDurableCampaignPersistenceEnabled()) {
    try {
      const persistedCampaign = await createDurableCampaign(newCampaign, { userId: user.id, email: user.email, role: membership.role });
      globalStore.campaigns.set(id, persistedCampaign);
      Object.assign(newCampaign, persistedCampaign);
      // The local cache is only a request-process convenience; PostgreSQL and its
      // hash-chained audit event were committed atomically by the RPC.
    } catch (error) {
      console.error('[CampaignRepository] create failed', error instanceof CampaignRepositoryError ? error.code : 'UNEXPECTED_ERROR');
      const status = error instanceof CampaignRepositoryError && error.code === 'CONFLICT' ? 409 : 503;
      return res.status(status).json({
        error: error instanceof CampaignRepositoryError ? error.code : 'DURABLE_CAMPAIGN_STORAGE_UNAVAILABLE',
        message: error instanceof CampaignRepositoryError && error.code === 'CONFLICT'
          ? error.message
          : 'Campaign could not be committed to durable storage. No local-only campaign was created.',
      });
    }
  } else {
    globalStore.campaigns.set(id, newCampaign);
  }

  // Audit
  const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
  const log = createAuditLogEntry({
    orgId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    actorRole: membership.role,
    action: 'CAMPAIGN_CREATED',
    entityType: 'CAMPAIGN',
    entityId: id,
    prevHash: prevLog?.hash,
    details: { name, provider, budgetMinorUnits, currency: campCurrency },
  });
  globalStore.auditLogs.push(log);
  persistCurrentStore();

  res.status(201).json(newCampaign);
});

apiRouter.patch('/campaigns/:id/status', async (req: ContextRequest, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;

  if (!hasPermission(membership.role, 'EDIT_CAMPAIGNS')) {
    return res.status(403).json({ error: 'Permission denied: Requires EDIT_CAMPAIGNS permission.' });
  }
  const validStatuses = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'REJECTED'];
  if (typeof status !== 'string' || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'INVALID_CAMPAIGN_STATUS', message: 'Status must be a supported campaign status.' });
  }
  if (status === 'ACTIVE') {
    return res.status(501).json({ error: 'PROVIDER_WRITE_NOT_IMPLEMENTED', message: 'Campaign activation is unavailable because live provider publishing is not implemented. The campaign remains unchanged.' });
  }

  let campaign = globalStore.campaigns.get(id);
  if (isDurableCampaignPersistenceEnabled()) {
    try {
      const durableCampaigns = await listCampaignsForOrganization(org.id);
      campaign = durableCampaigns.find((item) => item.id === id);
    } catch (error) {
      console.error('[CampaignRepository] status lookup failed', error instanceof CampaignRepositoryError ? error.code : 'UNEXPECTED_ERROR');
      return res.status(503).json({ error: 'DURABLE_CAMPAIGN_STORAGE_UNAVAILABLE', message: 'Campaign status cannot be changed until durable storage is available.' });
    }
  }
  if (!campaign || campaign.orgId !== org.id) {
    return res.status(404).json({ error: 'Campaign not found within active organization.' });
  }

  if (org.emergencyStopActive && (status === 'ACTIVE' || status === 'PENDING_APPROVAL')) {
    return res.status(403).json({
      error: 'EMERGENCY_STOP_ACTIVE: Cannot activate campaigns while Emergency Stop is engaged.',
    });
  }

  const oldStatus = campaign.status;
  if (isDurableCampaignPersistenceEnabled()) {
    try {
      campaign = await updateDurableCampaignStatus(
        org.id,
        id,
        campaign.version,
        status as Exclude<CampaignStatus, 'ACTIVE'>,
        { userId: user.id, email: user.email, role: membership.role }
      );
      globalStore.campaigns.set(id, campaign);
    } catch (error) {
      console.error('[CampaignRepository] status update failed', error instanceof CampaignRepositoryError ? error.code : 'UNEXPECTED_ERROR');
      const conflict = error instanceof CampaignRepositoryError && error.code === 'CONFLICT';
      return res.status(conflict ? 409 : error instanceof CampaignRepositoryError && error.code === 'NOT_FOUND' ? 404 : 503).json({
        error: error instanceof CampaignRepositoryError ? error.code : 'DURABLE_CAMPAIGN_STORAGE_UNAVAILABLE',
        message: error instanceof CampaignRepositoryError ? error.message : 'Campaign status was not changed because durable storage failed.',
      });
    }
  } else {
    campaign.status = status as CampaignStatus;
    campaign.version += 1;
    campaign.updatedAt = new Date().toISOString();
  }

  // Audit
  const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
  const log = createAuditLogEntry({
    orgId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    actorRole: membership.role,
    action: 'CAMPAIGN_STATUS_UPDATED',
    entityType: 'CAMPAIGN',
    entityId: id,
    prevHash: prevLog?.hash,
    details: { oldStatus, newStatus: status, version: campaign.version },
  });
  globalStore.auditLogs.push(log);
  persistCurrentStore();

  res.json(campaign);
});

// ---------------------------------------------------------------------------
// 4. Financial Safety & Budget Proposals
// ---------------------------------------------------------------------------

apiRouter.get('/finance/proposals', async (req: ContextRequest, res: Response) => {
  const org = req.org!;
  if (isDurableFinancePersistenceEnabled()) {
    try { return res.json(await listDurableProposals(org.id)); }
    catch (error) {
      const e = error as CampaignRepositoryError;
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'CONFLICT' ? 409 : 503;
      return res.status(status).json({ error: e.code, message: e.message });
    }
  }
  const proposals = Array.from(globalStore.proposals.values()).filter((p) => p.orgId === org.id);
  return res.json(proposals);
});

apiRouter.post('/finance/proposals', async (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;
  if (!hasPermission(membership.role, 'EDIT_CAMPAIGNS')) {
    return res.status(403).json({ error: 'Permission denied: Requires EDIT_CAMPAIGNS permission.' });
  }
  const { campaignId, proposedBudgetAmount, title, description, reason } = req.body || {};
  if (typeof campaignId !== 'string' || !campaignId.trim()) {
    return res.status(400).json({ error: 'CAMPAIGN_REQUIRED', message: 'Choose a campaign in the active organization.' });
  }
  const amount = Number(proposedBudgetAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'INVALID_BUDGET', message: 'Proposed budget must be a positive finite amount.' });
  }
  if (isDurableFinancePersistenceEnabled()) {
    try {
      const campaign = await getDurableCampaignForFinance(org.id, campaignId);
      const proposedBudgetMinorUnits = toMinorUnits(amount, campaign.currency);
      const proposal = await createDurableBudgetProposal({
        orgId: org.id, campaignId, proposedBudgetMinorUnits,
        title: typeof title === 'string' ? title.trim().slice(0, 255) : undefined,
        description: typeof description === 'string' ? description.trim().slice(0, 2000) : undefined,
        reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 2000) : 'Budget adjustment requested for campaign optimization.',
      }, { userId: user.id, email: user.email, role: membership.role });
      return res.status(201).json(proposal);
    } catch (error) {
      const e = error as CampaignRepositoryError;
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'CONFLICT' ? 409 : e.code === 'NOT_CONFIGURED' ? 403 : 503;
      return res.status(status).json({ error: e.code, message: e.message });
    }
  }

  const campaign = globalStore.campaigns.get(campaignId);
  if (!campaign || campaign.orgId !== org.id) return res.status(404).json({ error: 'Target campaign not found in active organization.' });
  const proposedBudgetMinorUnits = toMinorUnits(amount, campaign.currency);
  const policyCheck = evaluateBudgetPolicy({
    currentBudgetMinorUnits: campaign.budgetMinorUnits, proposedBudgetMinorUnits, currency: campaign.currency,
    thresholdMinorUnits: org.settings.budgetChangeApprovalThresholdMinorUnits,
    dailyCeilingMinorUnits: org.settings.dailySpendCeilingMinorUnits,
    requesterUserId: user.id, emergencyStopActive: org.emergencyStopActive,
    campaignVersion: campaign.version, proposalCampaignVersion: campaign.version,
  });
  if (!policyCheck.allowed) return res.status(400).json({ error: policyCheck.reasons.join(', ') });
  const id = randomUUID();
  const proposal: BudgetProposal = {
    id, orgId: org.id, campaignId,
    type: proposedBudgetMinorUnits > campaign.budgetMinorUnits ? 'BUDGET_INCREASE' : 'BUDGET_DECREASE',
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 255) : `Budget adjustment for ${campaign.name}`,
    description: typeof description === 'string' ? description.trim().slice(0, 2000) : `Request to adjust budget to ${formatCurrency(proposedBudgetMinorUnits, campaign.currency)}.`,
    requestedByUserId: user.id, requestedAt: new Date().toISOString(), status: 'PENDING',
    currentBudgetMinorUnits: campaign.budgetMinorUnits, proposedBudgetMinorUnits, currency: campaign.currency,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 2000) : 'Optimization and pacing adjustment.',
    campaignVersionAtRequest: campaign.version,
  };
  globalStore.proposals.set(id, proposal);
  const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
  globalStore.auditLogs.push(createAuditLogEntry({
    orgId: org.id, actorUserId: user.id, actorEmail: user.email, actorRole: membership.role,
    action: 'BUDGET_PROPOSAL_CREATED', entityType: 'PROPOSAL', entityId: id, prevHash: prevLog?.hash,
    details: { campaignId, currentBudget: campaign.budgetMinorUnits, proposedBudget: proposedBudgetMinorUnits },
  }));
  persistCurrentStore();
  return res.status(201).json(proposal);
});

apiRouter.post('/finance/proposals/:id/review', async (req: ContextRequest, res: Response) => {
  const { id } = req.params;
  const { action, notes } = req.body || {};
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;
  if (!hasPermission(membership.role, 'APPROVE_BUDGETS')) {
    return res.status(403).json({ error: 'Permission denied: Requires APPROVE_BUDGETS authority.' });
  }
  if (action !== 'APPROVE' && action !== 'REJECT') {
    return res.status(400).json({ error: 'INVALID_REVIEW_ACTION', message: 'Action must be APPROVE or REJECT.' });
  }
  if (isDurableFinancePersistenceEnabled()) {
    try {
      const proposal = await reviewDurableBudgetProposal({
        orgId: org.id, proposalId: id, action,
        notes: typeof notes === 'string' ? notes.trim().slice(0, 2000) : undefined,
      }, { userId: user.id, email: user.email, role: membership.role });
      if (proposal.status === 'STALE') {
        return res.status(409).json({ error: 'STALE_PROPOSAL', message: 'Campaign changed after the proposal was submitted. Create a new proposal.', proposal });
      }
      return res.json({ ...proposal, providerWritePerformed: false });
    } catch (error) {
      const e = error as CampaignRepositoryError;
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'CONFLICT' ? 409 : e.code === 'NOT_CONFIGURED' ? 403 : 503;
      return res.status(status).json({ error: e.code, message: e.message });
    }
  }
  const proposal = globalStore.proposals.get(id);
  if (!proposal || proposal.orgId !== org.id) return res.status(404).json({ error: 'Proposal not found in active organization.' });
  if (proposal.status !== 'PENDING') return res.status(400).json({ error: `Proposal already processed (status: ${proposal.status}).` });
  const campaign = globalStore.campaigns.get(proposal.campaignId);
  if (!campaign || campaign.orgId !== org.id) return res.status(404).json({ error: 'Campaign associated with proposal not found.' });
  if (org.settings.requireFourEyesApproval && proposal.requestedByUserId === user.id) {
    return res.status(403).json({ error: 'FOUR_EYES_VIOLATION: Requester cannot approve their own financial proposal.' });
  }
  if (org.emergencyStopActive) return res.status(403).json({ error: 'EMERGENCY_STOP_ACTIVE: Financial proposals cannot be reviewed while emergency stop is active.' });
  if (campaign.version !== proposal.campaignVersionAtRequest) {
    proposal.status = 'STALE';
    proposal.reviewNotes = 'Campaign changed after proposal submission; resubmission required.';
    persistCurrentStore();
    return res.status(409).json({ error: 'STALE_PROPOSAL', proposal });
  }
  proposal.reviewedByUserId = user.id;
  proposal.reviewedAt = new Date().toISOString();
  proposal.reviewNotes = typeof notes === 'string' ? notes.trim().slice(0, 2000) : undefined;
  if (action === 'APPROVE') {
    proposal.status = 'APPROVED';
    campaign.budgetMinorUnits = proposal.proposedBudgetMinorUnits;
    campaign.version += 1;
    campaign.updatedAt = new Date().toISOString();
  } else proposal.status = 'REJECTED';
  const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
  globalStore.auditLogs.push(createAuditLogEntry({
    orgId: org.id, actorUserId: user.id, actorEmail: user.email, actorRole: membership.role,
    action: action === 'APPROVE' ? 'BUDGET_PROPOSAL_APPROVED_LOCAL_ONLY' : 'BUDGET_PROPOSAL_REJECTED',
    entityType: 'PROPOSAL', entityId: id, prevHash: prevLog?.hash,
    details: { campaignId: campaign.id, status: proposal.status, providerWritePerformed: false },
  }));
  persistCurrentStore();
  return res.json({ ...proposal, providerWritePerformed: false });
});

// ---------------------------------------------------------------------------
// 5. Emergency Stop Killswitch
// ---------------------------------------------------------------------------

apiRouter.post('/finance/emergency-stop', async (req: ContextRequest, res: Response) => {
  const { action, reason } = req.body || {};
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;
  if (action !== 'TRIGGER' && action !== 'RELEASE') {
    return res.status(400).json({ error: 'INVALID_EMERGENCY_STOP_ACTION', message: 'Action must be TRIGGER or RELEASE.' });
  }
  const reqPerm = action === 'TRIGGER' ? 'TRIGGER_EMERGENCY_STOP' : 'RELEASE_EMERGENCY_STOP';
  if (!hasPermission(membership.role, reqPerm)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: `Permission denied: Requires ${reqPerm}.` });
  }
  if (isDurableFinancePersistenceEnabled()) {
    try {
      const result = await setDurableEmergencyStop({
        orgId: org.id, action,
        reason: typeof reason === 'string' ? reason.trim().slice(0, 1000) : undefined,
      }, { userId: user.id, email: user.email, role: membership.role });
      return res.json({
        success: true, ...result,
        message: action === 'TRIGGER'
          ? 'Emergency stop is persisted. Internal active campaign records were paused; no provider-side pause request was sent.'
          : 'Emergency stop released. Provider-side campaigns were not changed.',
        providerWritePerformed: false,
      });
    } catch (error) {
      const e = error as CampaignRepositoryError;
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'CONFLICT' ? 409 : e.code === 'NOT_CONFIGURED' ? 403 : 503;
      return res.status(status).json({ error: e.code, message: e.message });
    }
  }

  if (action === 'TRIGGER') {
    org.emergencyStopActive = true;
    org.emergencyStopReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 1000) : 'Immediate operational containment requested.';
    org.emergencyStopTriggeredAt = new Date().toISOString();
    org.emergencyStopTriggeredBy = user.name;
    let pausedCount = 0;
    for (const cmp of globalStore.campaigns.values()) {
      if (cmp.orgId === org.id && cmp.status === 'ACTIVE') { cmp.status = 'PAUSED'; cmp.version += 1; pausedCount++; }
    }
    const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
    globalStore.auditLogs.push(createAuditLogEntry({
      orgId: org.id, actorUserId: user.id, actorEmail: user.email, actorRole: membership.role,
      action: 'EMERGENCY_STOP_TRIGGERED', entityType: 'ORGANIZATION', entityId: org.id, prevHash: prevLog?.hash,
      details: { reason: org.emergencyStopReason, pausedCampaignsCount: pausedCount, providerWritePerformed: false },
    }));
    persistCurrentStore();
    return res.json({ success: true, message: 'Emergency stop is active in the local workspace. Internal records were paused; no live provider pause API is configured.', org, providerWritePerformed: false });
  }
  org.emergencyStopActive = false;
  org.emergencyStopReason = undefined;
  const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
  globalStore.auditLogs.push(createAuditLogEntry({
    orgId: org.id, actorUserId: user.id, actorEmail: user.email, actorRole: membership.role,
    action: 'EMERGENCY_STOP_RELEASED', entityType: 'ORGANIZATION', entityId: org.id, prevHash: prevLog?.hash,
    details: { releasedBy: user.email, providerWritePerformed: false },
  }));
  persistCurrentStore();
  return res.json({ success: true, message: 'Emergency Stop released. No provider-side action was performed.', org, providerWritePerformed: false });
});

// ---------------------------------------------------------------------------
// 6. Provider Connectors
// ---------------------------------------------------------------------------

apiRouter.get('/providers', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const connections = Array.from(globalStore.providerConnections.values()).filter(
    (c) => c.orgId === org.id
  );
  res.json({
    catalog: PROVIDER_CATALOG,
    connections,
  });
});

apiRouter.post('/providers/:id/sync', (req: ContextRequest, res: Response) => {
  const { id } = req.params;
  const org = req.org!;
  const membership = req.membership!;
  if (!hasPermission(membership.role, 'CONNECT_PROVIDERS')) {
    return res.status(403).json({ error: 'Permission denied: Requires CONNECT_PROVIDERS permission.' });
  }
  const conn = globalStore.providerConnections.get(id);

  if (!conn || conn.orgId !== org.id) {
    return res.status(404).json({ error: 'Connection not found in active organization.' });
  }

  // Never report a healthy sync without making a real provider API request.
  conn.syncStatus = 'ERROR';
  conn.errorMessage = 'Live provider synchronization is not implemented for this connection.';
  persistCurrentStore();
  res.status(501).json({
    error: 'PROVIDER_SYNC_NOT_IMPLEMENTED',
    message: 'This connector is catalog-only. No live provider API request was made.',
    connection: conn,
  });
});

// ---------------------------------------------------------------------------
// 7. Analytics & Reporting
// ---------------------------------------------------------------------------

apiRouter.get('/analytics', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const campaigns = Array.from(globalStore.campaigns.values()).filter((c) => c.orgId === org.id);

  let totalSpendMinorUnits = 0;
  let totalRevenueMinorUnits = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalConversions = 0;

  const platformBreakdown: Record<string, { spend: number; revenue: number; clicks: number; conversions: number }> = {};

  campaigns.forEach((c) => {
    totalSpendMinorUnits += c.actualSpendMinorUnits;
    totalRevenueMinorUnits += c.revenueMinorUnits;
    totalImpressions += c.impressions;
    totalClicks += c.clicks;
    totalConversions += c.conversions;

    if (!platformBreakdown[c.provider]) {
      platformBreakdown[c.provider] = { spend: 0, revenue: 0, clicks: 0, conversions: 0 };
    }
    platformBreakdown[c.provider].spend += fromMinorUnits(c.actualSpendMinorUnits, c.currency);
    platformBreakdown[c.provider].revenue += fromMinorUnits(c.revenueMinorUnits, c.currency);
    platformBreakdown[c.provider].clicks += c.clicks;
    platformBreakdown[c.provider].conversions += c.conversions;
  });

  const metrics = calculateMarketingMetrics({
    spendMinorUnits: totalSpendMinorUnits,
    impressions: totalImpressions,
    clicks: totalClicks,
    conversions: totalConversions,
    revenueMinorUnits: totalRevenueMinorUnits,
    currency: org.defaultCurrency,
  });

  res.json({
    totals: metrics,
    currency: org.defaultCurrency,
    totalCampaigns: campaigns.length,
    activeCampaigns: campaigns.filter((c) => c.status === 'ACTIVE').length,
    platformBreakdown,
    attributionWindow: '7-day click, 1-day view (Verified Cross-Channel)',
    freshnessTimestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// 8. AI Advertising Copilot
// ---------------------------------------------------------------------------

apiRouter.post('/copilot/query', copilotLimiter, async (req: ContextRequest, res: Response) => {
  const { prompt, language } = req.body;
  const org = req.org!;
  const campaigns = Array.from(globalStore.campaigns.values()).filter((c) => c.orgId === org.id);
  const brand = Array.from(globalStore.brandProfiles.values()).find((b) => b.orgId === org.id);

  try {
    const result = await askCopilot({
      userPrompt: prompt || '',
      org,
      campaigns,
      brand,
      language: language || 'en',
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({
      error: 'Copilot query execution error',
      details: String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// 9. Creatives & Brand Studio
// ---------------------------------------------------------------------------

apiRouter.get('/creatives', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const creatives = Array.from(globalStore.creatives.values()).filter((c) => c.orgId === org.id);
  const brandProfiles = Array.from(globalStore.brandProfiles.values()).filter((b) => b.orgId === org.id);
  res.json({ creatives, brandProfiles });
});

apiRouter.post('/creatives', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const membership = req.membership!;

  if (!hasPermission(membership.role, 'MANAGE_CREATIVES')) {
    return res.status(403).json({ error: 'Permission denied: Requires MANAGE_CREATIVES permission.' });
  }

  const { name, headline, description, callToAction, targetUrl, platformFormats, language, imageUrl } = req.body;

  // Validate format constraints
  const errors: string[] = [];
  (platformFormats || ['meta']).forEach((p: any) => {
    const v = validateCreativeForProvider(p, headline || '', description || '');
    if (!v.valid) {
      errors.push(...v.errors);
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join(' ') });
  }

  // Calculate brand safety score
  const brand = Array.from(globalStore.brandProfiles.values()).find((b) => b.orgId === org.id);
  const brandNotes: string[] = [];
  let score = 100;

  if (brand) {
    for (const badWord of brand.disallowedKeywords) {
      if (
        (headline && headline.toLowerCase().includes(badWord.toLowerCase())) ||
        (description && description.toLowerCase().includes(badWord.toLowerCase()))
      ) {
        score -= 30;
        brandNotes.push(`Disallowed keyword found: "${badWord}"`);
      }
    }
  }

  const id = `crt_${Date.now()}`;
  const newAsset: CreativeAsset = {
    id,
    orgId: org.id,
    name: name || 'Untitled Asset',
    brandProfileId: brand?.id || 'default_brand',
    headline: headline || '',
    description: description || '',
    callToAction: callToAction || 'LEARN_MORE',
    targetUrl: targetUrl || 'https://example.com',
    platformFormats: platformFormats || ['meta'],
    language: language || 'en',
    status: score >= 80 ? 'APPROVED' : 'IN_REVIEW',
    brandSafetyScore: Math.max(0, score),
    brandSafetyNotes: brandNotes.length > 0 ? brandNotes : ['Brand guidelines verified.'],
    imageUrl: imageUrl || 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=600',
    createdAt: new Date().toISOString(),
  };

  globalStore.creatives.set(id, newAsset);
  persistCurrentStore();
  res.status(201).json(newAsset);
});

// ---------------------------------------------------------------------------
// 10. Leads & Messaging Module
// ---------------------------------------------------------------------------

apiRouter.get('/leads', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const leads = Array.from(globalStore.leads.values()).filter((l) => l.orgId === org.id);
  res.json(leads);
});

apiRouter.patch('/leads/:id/status', (req: ContextRequest, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  const org = req.org!;
  const membership = req.membership!;
  if (!hasPermission(membership.role, 'MANAGE_LEADS')) {
    return res.status(403).json({ error: 'Permission denied: Requires MANAGE_LEADS permission.' });
  }
  const lead = globalStore.leads.get(id);

  if (!lead || lead.orgId !== org.id) {
    return res.status(404).json({ error: 'Lead not found in active organization.' });
  }

  const validStatuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED'];
  if (typeof status !== 'string' || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'INVALID_LEAD_STATUS', message: 'Status must be NEW, CONTACTED, QUALIFIED, CONVERTED, or DISQUALIFIED.' });
  }
  lead.status = status as LeadRecord['status'];
  persistCurrentStore();
  res.json(lead);
});

// ---------------------------------------------------------------------------
// 11. Audit Logs & Chain Verification
// ---------------------------------------------------------------------------

apiRouter.get('/audit', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const logs = globalStore.auditLogs.filter((l) => l.orgId === org.id);
  const chainVerification = verifyAuditChain(logs);
  res.json({
    logs: [...logs].reverse(),
    chainVerification,
  });
});

// ---------------------------------------------------------------------------
// 12. PostgreSQL & System Health / Readiness
// ---------------------------------------------------------------------------

apiRouter.get('/health', (_req: Request, res: Response) => {
  // Public liveness must not disclose tenant counts or persistence internals.
  // This endpoint confirms process availability, not production readiness.
  res.json({
    status: 'ONLINE',
    version: '2.5.0',
    timestamp: new Date().toISOString(),
    persistence: {
      mode: process.env.VERCEL ? 'SERVERLESS_SNAPSHOT_COMPATIBILITY' : 'LOCAL_FILE_SNAPSHOT_COMPATIBILITY',
      productionReady: false,
    },
  });
});

apiRouter.get('/health/ready', async (_req: Request, res: Response) => {
  // Never infer readiness from seeded in-memory demo data. The current snapshot
  // adapter is not concurrency-safe for serverless multi-tenant writes.
  const database = await testSupabaseConnection();
  return res.status(503).json({
    ready: false,
    productionReady: false,
    dependencies: { supabase: database.ok ? 'CONNECTED' : 'UNAVAILABLE' },
    blockers: ['DURABLE_TRANSACTIONAL_TENANT_PERSISTENCE_NOT_IMPLEMENTED'],
    message: 'Controlled staging requests are available, but production readiness is blocked until normalized, transactional tenant-scoped persistence replaces the process-local store and whole-state snapshot.',
  });
});
