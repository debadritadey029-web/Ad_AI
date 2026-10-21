/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response, NextFunction } from 'express';
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
import { PostgresAdapter } from './db/postgres.js';
import { PersistenceManager } from './db/persistence.js';
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
import { getSupabaseServerStatus, testSupabaseConnection } from './db/supabase.js';
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
function resolveContext(req: ContextRequest, res: Response, next: NextFunction) {
  // Allow public authentication, OTP, and status endpoints to pass through without requiring active session
  const publicPaths = [
    '/health',
    '/health/ready',
    '/supabase/status',
    '/supabase/test',
    '/auth/login',
    '/auth/login-step1',
    '/auth/login-step2',
    '/auth/otp/send',
    '/auth/otp/verify',
    '/auth/demo-login',
  ];
  if (publicPaths.some((p) => req.path.endsWith(p) || req.path === p)) {
    return next();
  }

  const token = extractAuthToken(req);
  let session: Session | null = null;

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHENTICATED',
      message: 'Authentication required. Please sign in to continue.',
    });
  }

  session = validateSessionToken(token);
  if (!session) {
    return res.status(401).json({
      error: 'INVALID_SESSION',
      message: 'Provided session token is invalid or expired. Please re-authenticate.',
    });
  }

  // Determine user only from the verified session.
  const userId = session.userId;
  const user = globalStore.users.get(userId);
  if (!user) {
    return res.status(401).json({ error: 'USER_NOT_FOUND', message: 'User does not exist.' });
  }

  // Determine requested org: header override, or session active org, or fallback
  const requestedOrgId =
    (req.headers['x-organization-id'] as string) || session.activeOrgId;

  const org = globalStore.organizations.get(requestedOrgId);
  if (!org) {
    return res.status(404).json({
      error: 'ORGANIZATION_NOT_FOUND',
      message: `Organization '${requestedOrgId}' does not exist.`,
    });
  }

  // Enforce Tenant Isolation: User must have ACTIVE membership in the requested org
  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === user.id && m.orgId === org.id && m.status === 'ACTIVE'
  );

  if (!membership) {
    return res.status(403).json({
      error: 'TENANT_ACCESS_DENIED',
      message: `Access denied: User '${user.name}' has no active membership in organization '${org.name}'. Cross-tenant access is prohibited.`,
    });
  }

  req.user = user;
  req.org = org;
  req.membership = membership;
  req.session = session || undefined;
  req.token = token || undefined;

  next();
}

// Apply context resolution to all protected API routes
apiRouter.use(resolveContext);

// ---------------------------------------------------------------------------
// 1. Two-Step Authentication & OTP Endpoints (Email & Phone)
// ---------------------------------------------------------------------------

/**
 * Step 1: Initiates OTP code transmission to Email or Phone number
 */
apiRouter.post('/auth/otp/send', authLimiter, (req: Request, res: Response) => {
  const { target, channel = 'email', purpose = 'OTP_LOGIN' } = req.body;
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

  // OTP delivery is not integrated yet. Do not claim a message was sent or expose a code in production.
  if (isProduction()) {
    return res.status(503).json({
      error: 'OTP_DELIVERY_NOT_CONFIGURED',
      message: 'Secure email/SMS delivery is not configured. Sign-in by OTP is temporarily unavailable.',
    });
  }

  const result = sendOtp({
    target,
    channel: effectiveChannel,
    purpose: purpose as any,
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
    // No delivery adapter is configured yet; fail closed rather than returning an OTP to the client.
    if (isProduction()) {
      return res.status(503).json({
        error: 'OTP_DELIVERY_NOT_CONFIGURED',
        message: 'Secure email/SMS delivery is not configured. Two-factor sign-in is temporarily unavailable.',
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
  const orgId = membership ? membership.orgId : 'org_apex';

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
  const orgId = membership ? membership.orgId : 'org_apex';

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

  // This legacy endpoint skips the 2FA challenge. Disable it in production until all
  // accounts are routed through a configured delivery-backed step-1/step-2 flow.
  if (isProduction()) {
    return res.status(503).json({
      error: 'SECURE_LOGIN_NOT_CONFIGURED',
      message: 'Production sign-in is unavailable until secure two-factor delivery is configured.',
    });
  }
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
  const orgId = membership ? membership.orgId : 'org_apex';

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
    user: globalStore.users.get(userId),
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

  session.activeOrgId = org.id;
  persistCurrentStore();
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
  res.json(Array.from(globalStore.organizations.values()));
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

apiRouter.get('/campaigns', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const campaigns = Array.from(globalStore.campaigns.values()).filter((c) => c.orgId === org.id);
  res.json(campaigns);
});

apiRouter.post('/campaigns', (req: ContextRequest, res: Response) => {
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

  if (!budgetAmount || isNaN(Number(budgetAmount)) || Number(budgetAmount) <= 0) {
    return res.status(400).json({ error: 'Valid positive budget amount is required.' });
  }

  const campCurrency = currency || org.defaultCurrency;
  const budgetMinorUnits = toMinorUnits(Number(budgetAmount), campCurrency);

  // Validate provider minimum budget
  const minValidation = validateCampaignMinBudget(provider, budgetMinorUnits, campCurrency);
  if (!minValidation.valid) {
    return res.status(400).json({ error: minValidation.error });
  }

  // Check against org daily ceiling
  if (budgetMinorUnits > org.settings.dailySpendCeilingMinorUnits) {
    return res.status(400).json({
      error: `Budget exceeds organization daily ceiling of ${formatCurrency(org.settings.dailySpendCeilingMinorUnits, campCurrency)}.`,
    });
  }

  const id = `cmp_${provider}_${Date.now()}`;
  const newCampaign: Campaign = {
    id,
    orgId: org.id,
    provider,
    providerAccountId: providerAccountId || 'unlinked',
    name: name.trim(),
    objective: objective || 'CONVERSIONS',
    // Creating a local record does not publish it to an advertising platform.
    status: 'DRAFT',
    budgetType: budgetType || 'DAILY',
    budgetMinorUnits,
    currency: campCurrency,
    startDate: startDate || new Date().toISOString(),
    endDate,
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

  globalStore.campaigns.set(id, newCampaign);

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

apiRouter.patch('/campaigns/:id/status', (req: ContextRequest, res: Response) => {
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

  const campaign = globalStore.campaigns.get(id);
  if (!campaign || campaign.orgId !== org.id) {
    return res.status(404).json({ error: 'Campaign not found within active organization.' });
  }

  if (org.emergencyStopActive && (status === 'ACTIVE' || status === 'PENDING_APPROVAL')) {
    return res.status(403).json({
      error: 'EMERGENCY_STOP_ACTIVE: Cannot activate campaigns while Emergency Stop is engaged.',
    });
  }

  const oldStatus = campaign.status;
  campaign.status = status;
  campaign.version += 1;
  campaign.updatedAt = new Date().toISOString();

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

apiRouter.get('/finance/proposals', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const proposals = Array.from(globalStore.proposals.values()).filter((p) => p.orgId === org.id);
  res.json(proposals);
});

apiRouter.post('/finance/proposals', (req: ContextRequest, res: Response) => {
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;

  if (!hasPermission(membership.role, 'EDIT_CAMPAIGNS')) {
    return res.status(403).json({ error: 'Permission denied: Requires EDIT_CAMPAIGNS permission.' });
  }

  const { campaignId, proposedBudgetAmount, title, description, reason } = req.body;
  const campaign = globalStore.campaigns.get(campaignId);

  if (!campaign || campaign.orgId !== org.id) {
    return res.status(404).json({ error: 'Target campaign not found in active organization.' });
  }

  const proposedBudgetMinorUnits = toMinorUnits(Number(proposedBudgetAmount), campaign.currency);

  const policyCheck = evaluateBudgetPolicy({
    currentBudgetMinorUnits: campaign.budgetMinorUnits,
    proposedBudgetMinorUnits,
    currency: campaign.currency,
    thresholdMinorUnits: org.settings.budgetChangeApprovalThresholdMinorUnits,
    dailyCeilingMinorUnits: org.settings.dailySpendCeilingMinorUnits,
    requesterUserId: user.id,
    emergencyStopActive: org.emergencyStopActive,
    campaignVersion: campaign.version,
    proposalCampaignVersion: campaign.version,
  });

  if (!policyCheck.allowed) {
    return res.status(400).json({ error: policyCheck.reasons.join(', ') });
  }

  const id = `prp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const proposal: BudgetProposal = {
    id,
    orgId: org.id,
    campaignId,
    type: proposedBudgetMinorUnits > campaign.budgetMinorUnits ? 'BUDGET_INCREASE' : 'BUDGET_DECREASE',
    title: title || `Budget adjustment for ${campaign.name}`,
    description: description || `Request to adjust budget to ${formatCurrency(proposedBudgetMinorUnits, campaign.currency)}.`,
    requestedByUserId: user.id,
    requestedAt: new Date().toISOString(),
    status: 'PENDING',
    currentBudgetMinorUnits: campaign.budgetMinorUnits,
    proposedBudgetMinorUnits,
    currency: campaign.currency,
    reason: reason || 'Optimization and pacing adjustment.',
    campaignVersionAtRequest: campaign.version,
  };

  globalStore.proposals.set(id, proposal);

  // Audit
  const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
  const log = createAuditLogEntry({
    orgId: org.id,
    actorUserId: user.id,
    actorEmail: user.email,
    actorRole: membership.role,
    action: 'BUDGET_PROPOSAL_CREATED',
    entityType: 'PROPOSAL',
    entityId: id,
    prevHash: prevLog?.hash,
    details: {
      campaignId,
      currentBudget: campaign.budgetMinorUnits,
      proposedBudget: proposedBudgetMinorUnits,
    },
  });
  globalStore.auditLogs.push(log);
  persistCurrentStore();

  res.status(201).json(proposal);
});

apiRouter.post('/finance/proposals/:id/review', (req: ContextRequest, res: Response) => {
  const { id } = req.params;
  const { action, notes } = req.body; // action: 'APPROVE' | 'REJECT'
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;

  if (!hasPermission(membership.role, 'APPROVE_BUDGETS')) {
    return res.status(403).json({ error: 'Permission denied: Requires APPROVE_BUDGETS authority.' });
  }

  const proposal = globalStore.proposals.get(id);
  if (!proposal || proposal.orgId !== org.id) {
    return res.status(404).json({ error: 'Proposal not found in active organization.' });
  }

  if (proposal.status !== 'PENDING') {
    return res.status(400).json({ error: `Proposal already processed (status: ${proposal.status}).` });
  }

  const campaign = globalStore.campaigns.get(proposal.campaignId);
  if (!campaign) {
    return res.status(404).json({ error: 'Campaign associated with proposal not found.' });
  }

  // Four-Eyes Principle: Requester CANNOT approve their own proposal
  if (org.settings.requireFourEyesApproval && proposal.requestedByUserId === user.id) {
    return res.status(403).json({
      error: 'FOUR_EYES_VIOLATION: Requester cannot approve their own financial proposal.',
    });
  }

  // Emergency Stop check
  if (org.emergencyStopActive) {
    return res.status(403).json({
      error: 'EMERGENCY_STOP_ACTIVE: No financial proposals can be executed while killswitch is engaged.',
    });
  }

  // Stale proposal optimistic locking check
  if (campaign.version !== proposal.campaignVersionAtRequest) {
    proposal.status = 'STALE';
    proposal.reviewNotes = `Proposal marked STALE because campaign version changed from ${proposal.campaignVersionAtRequest} to ${campaign.version}.`;
    persistCurrentStore();
    return res.status(409).json({
      error: 'STALE_PROPOSAL: Campaign was modified after proposal was submitted. Re-submission required.',
      proposal,
    });
  }

  if (action !== 'APPROVE' && action !== 'REJECT') {
    return res.status(400).json({ error: 'INVALID_REVIEW_ACTION', message: 'Action must be APPROVE or REJECT.' });
  }

  if (action === 'APPROVE') {
    // This application has no live provider budget-write adapter. Approval is recorded
    // as APPROVED (not EXECUTED) and only updates the internal draft configuration.
    proposal.status = 'APPROVED';
    proposal.reviewedByUserId = user.id;
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewNotes = notes || 'Approved in the local workspace only; no provider-side budget update was executed.';

    // Execute change on campaign
    campaign.budgetMinorUnits = proposal.proposedBudgetMinorUnits;
    campaign.version += 1;
    campaign.updatedAt = new Date().toISOString();

    const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
    const log = createAuditLogEntry({
      orgId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: membership.role,
      action: 'BUDGET_PROPOSAL_APPROVED_LOCAL_ONLY',
      entityType: 'PROPOSAL',
      entityId: id,
      prevHash: prevLog?.hash,
      details: {
        campaignId: campaign.id,
        newBudgetMinorUnits: campaign.budgetMinorUnits,
        approverId: user.id,
      },
    });
    globalStore.auditLogs.push(log);
  } else {
    proposal.status = 'REJECTED';
    proposal.reviewedByUserId = user.id;
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewNotes = notes || 'Rejected during financial review.';

    const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
    const log = createAuditLogEntry({
      orgId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: membership.role,
      action: 'BUDGET_PROPOSAL_REJECTED',
      entityType: 'PROPOSAL',
      entityId: id,
      prevHash: prevLog?.hash,
      details: { notes },
    });
    globalStore.auditLogs.push(log);
  }

  persistCurrentStore();
  res.json(proposal);
});

// ---------------------------------------------------------------------------
// 5. Emergency Stop Killswitch
// ---------------------------------------------------------------------------

apiRouter.post('/finance/emergency-stop', (req: ContextRequest, res: Response) => {
  const { action, reason } = req.body; // action: 'TRIGGER' | 'RELEASE'
  const org = req.org!;
  const user = req.user!;
  const membership = req.membership!;

  const reqPerm = action === 'TRIGGER' ? 'TRIGGER_EMERGENCY_STOP' : 'RELEASE_EMERGENCY_STOP';
  if (!hasPermission(membership.role, reqPerm)) {
    return res.status(403).json({ error: `Permission denied: Requires ${reqPerm}.` });
  }

  if (action === 'TRIGGER') {
    org.emergencyStopActive = true;
    org.emergencyStopReason = reason || 'Immediate operational containment requested.';
    org.emergencyStopTriggeredAt = new Date().toISOString();
    org.emergencyStopTriggeredBy = user.name;

    // Pause all active campaigns in org as precaution
    let pausedCount = 0;
    for (const cmp of globalStore.campaigns.values()) {
      if (cmp.orgId === org.id && cmp.status === 'ACTIVE') {
        cmp.status = 'PAUSED';
        cmp.version += 1;
        pausedCount++;
      }
    }

    const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
    const log = createAuditLogEntry({
      orgId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: membership.role,
      action: 'EMERGENCY_STOP_TRIGGERED',
      entityType: 'ORGANIZATION',
      entityId: org.id,
      prevHash: prevLog?.hash,
      details: { reason, pausedCampaignsCount: pausedCount },
    });
    globalStore.auditLogs.push(log);
    persistCurrentStore();

    res.json({
      success: true,
      message: 'Emergency stop is active in the local workspace. Campaign records were marked paused locally; no live provider pause API is configured.',
      org,
    });
  } else {
    org.emergencyStopActive = false;
    org.emergencyStopReason = undefined;

    const prevLog = globalStore.auditLogs[globalStore.auditLogs.length - 1];
    const log = createAuditLogEntry({
      orgId: org.id,
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: membership.role,
      action: 'EMERGENCY_STOP_RELEASED',
      entityType: 'ORGANIZATION',
      entityId: org.id,
      prevHash: prevLog?.hash,
      details: { releasedBy: user.email },
    });
    globalStore.auditLogs.push(log);
    persistCurrentStore();

    res.json({
      success: true,
      message: 'Emergency Stop released. Normal operational safeguards restored.',
      org,
    });
  }
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
  const lead = globalStore.leads.get(id);

  if (!lead || lead.orgId !== org.id) {
    return res.status(404).json({ error: 'Lead not found in active organization.' });
  }

  const validStatuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED'];
  if (typeof status !== 'string' || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'INVALID_LEAD_STATUS', message: 'Status must be NEW, CONTACTED, QUALIFIED, CONVERTED, or DISQUALIFIED.' });
  }
  lead.status = status;
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

apiRouter.get('/health', (req: Request, res: Response) => {
  const pgAdapter = new PostgresAdapter();
  const persistenceStatus = PersistenceManager.getInstance().getStorageStatus();

  res.json({
    status: 'ONLINE',
    version: '2.5.0',
    timestamp: new Date().toISOString(),
    postgresStatus: pgAdapter.getStatus(),
    persistence: {
      mode: 'ATOMIC_FILE_SYNC',
      status: persistenceStatus.exists ? 'PERSISTENT' : 'INITIALIZING',
      sizeBytes: persistenceStatus.sizeBytes,
    },
    activeCounts: {
      organizations: globalStore.organizations.size,
      users: globalStore.users.size,
      campaigns: globalStore.campaigns.size,
      proposals: globalStore.proposals.size,
      creatives: globalStore.creatives.size,
      leads: globalStore.leads.size,
      auditLogs: globalStore.auditLogs.length,
      activeSessions: globalStore.sessions.size,
    },
  });
});

apiRouter.get('/health/ready', (req: Request, res: Response) => {
  const ready = globalStore.organizations.size > 0 && globalStore.users.size > 0;
  if (ready) {
    return res.json({ ready: true, message: 'All operational subsystems ready for test traffic.' });
  }
  return res.status(503).json({ ready: false, message: 'Subsystems initializing.' });
});
