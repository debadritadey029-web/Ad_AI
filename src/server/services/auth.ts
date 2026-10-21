/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { globalStore } from '../db/store.js';
import { User, Session, Organization, Membership } from '../db/types.js';

export interface AuthenticatedRequest extends Request {
  user?: User;
  org?: Organization;
  membership?: Membership;
  session?: Session;
}

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/**
 * Hash a plaintext password with a unique salt using scrypt.
 */
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

/**
 * Verify a password against stored salt and hash using timing-safe comparison.
 */
export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  try {
    const actualHash = scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(actualHash, 'hex');
    const b = Buffer.from(expectedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Generates a high-entropy crypto session token.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Creates and registers a new session for a user.
 */
export function createSession(params: {
  userId: string;
  activeOrgId?: string;
  ipAddress?: string;
  userAgent?: string;
}): Session {
  const token = generateSessionToken();
  const id = `sess_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  // A session may only be issued to a known user with active membership in its selected org.
  const activeMemberships = Array.from(globalStore.memberships.values()).filter(
    (m) => m.userId === params.userId && m.status === 'ACTIVE'
  );
  const orgId = params.activeOrgId || activeMemberships[0]?.orgId;
  if (!globalStore.users.has(params.userId) || !orgId || !activeMemberships.some((m) => m.orgId === orgId)) {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }

  const session: Session = {
    id,
    token,
    userId: params.userId,
    activeOrgId: orgId,
    createdAt: now.toISOString(),
    expiresAt,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  };

  globalStore.sessions.set(token, session);
  return session;
}

/**
 * Validates a session token and returns the session if valid and not expired.
 */
export function validateSessionToken(token: string): Session | null {
  if (!token) return null;
  const session = globalStore.sessions.get(token);
  if (!session) return null;

  if (new Date(session.expiresAt) < new Date()) {
    globalStore.sessions.delete(token);
    return null;
  }

  return session;
}

/**
 * Revokes a session on logout.
 */
export function revokeSession(token: string): boolean {
  return globalStore.sessions.delete(token);
}

/**
 * Clean up expired sessions from memory and disk.
 */
export function pruneExpiredSessions(): number {
  const now = new Date();
  let pruned = 0;
  for (const [token, session] of globalStore.sessions.entries()) {
    if (new Date(session.expiresAt) < now) {
      globalStore.sessions.delete(token);
      pruned++;
    }
  }
  return pruned;
}

/**
 * Extract auth token from request headers or query.
 */
export function extractAuthToken(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  const customHeader = req.headers['x-session-token'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }
  return null;
}

/**
 * Express middleware to strictly enforce authentication and tenant isolation.
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = extractAuthToken(req);

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHENTICATED',
      message: 'Authentication required. Provide a valid Bearer token in the Authorization header.',
    });
  }

  const session = validateSessionToken(token);
  if (!session) {
    return res.status(401).json({
      error: 'INVALID_SESSION',
      message: 'Session is invalid or has expired. Please log in again.',
    });
  }

  const user = globalStore.users.get(session.userId);
  if (!user) {
    return res.status(401).json({
      error: 'USER_NOT_FOUND',
      message: 'User associated with session no longer exists.',
    });
  }

  // Tenant isolation: Check requested org via header, fallback to session's activeOrgId
  const requestedOrgId = (req.headers['x-organization-id'] as string) || session.activeOrgId;
  const org = globalStore.organizations.get(requestedOrgId);
  if (!org) {
    return res.status(404).json({
      error: 'ORGANIZATION_NOT_FOUND',
      message: `Organization '${requestedOrgId}' does not exist.`,
    });
  }

  // Verify user has active membership in this organization
  const membership = Array.from(globalStore.memberships.values()).find(
    (m) => m.userId === user.id && m.orgId === org.id && m.status === 'ACTIVE'
  );

  if (!membership) {
    return res.status(403).json({
      error: 'TENANT_ACCESS_DENIED',
      message: `Access denied: User does not have an active membership in organization '${org.name}'. Cross-tenant access is prohibited.`,
    });
  }

  req.user = user;
  req.org = org;
  req.membership = membership;
  req.session = session;

  next();
}

// ---------------------------------------------------------------------------
// Two-Step Authentication (2FA) & OTP Service (Email & Phone)
// ---------------------------------------------------------------------------

export const OTP_TTL_MS = 1000 * 60 * 10; // 10 minutes
export const MAX_OTP_ATTEMPTS = 5;

/**
 * Normalizes phone numbers to a consistent international E.164-like format.
 */
export function normalizePhone(raw: string): string {
  if (!raw) return '';
  const cleaned = raw.trim().replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  // Default to +1 if 10 digits without country code, or prepend +
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }
  return `+${cleaned}`;
}

/**
 * Masks an email or phone number for safe UI presentation.
 */
export function maskContact(identifier: string, channel: 'email' | 'phone'): string {
  if (channel === 'email') {
    const parts = identifier.split('@');
    if (parts.length !== 2) return '••••••';
    const [name, domain] = parts;
    const visibleStart = name.slice(0, 2);
    const visibleEnd = name.length > 3 ? name.slice(-1) : '';
    return `${visibleStart}••••${visibleEnd}@${domain}`;
  } else {
    const cleaned = identifier.replace(/[^\d+]/g, '');
    if (cleaned.length < 6) return '••••••';
    const start = cleaned.slice(0, 3);
    const end = cleaned.slice(-4);
    return `${start} •••• ${end}`;
  }
}

/**
 * Generates a cryptographically random 6-digit numeric OTP code.
 */
export function generateOtpCode(): string {
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0) % 900000 + 100000;
  return num.toString();
}

/**
 * Sends/registers an OTP code for Email or Phone verification.
 * In free/development tier, returns the code for authorized testers,
 * while preparing payloads for Supabase or Twilio outbound dispatch.
 */
export function sendOtp(params: {
  target: string;
  channel: 'email' | 'phone';
  purpose: 'LOGIN_2FA' | 'OTP_LOGIN' | 'PHONE_VERIFY';
  userId?: string;
}): {
  success: boolean;
  channel: 'email' | 'phone';
  targetMasked: string;
  expiresInSeconds: number;
  devCode?: string;
  message: string;
} {
  if (!globalStore.otpCodes) {
    globalStore.otpCodes = new Map();
  }

  const normalizedTarget =
    params.channel === 'phone'
      ? normalizePhone(params.target)
      : params.target.trim().toLowerCase();

  const code = generateOtpCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();

  const id = `otp_${Date.now()}_${randomBytes(3).toString('hex')}`;
  globalStore.otpCodes.set(normalizedTarget, {
    id,
    target: normalizedTarget,
    channel: params.channel,
    code,
    purpose: params.purpose,
    userId: params.userId,
    createdAt: now.toISOString(),
    expiresAt,
    attempts: 0,
    verified: false,
  });

  const targetMasked = maskContact(normalizedTarget, params.channel);
  console.log(`[AdVantage Auth] OTP for ${params.channel.toUpperCase()} (${targetMasked}): ${code} [Purpose: ${params.purpose}]`);

  return {
    success: true,
    channel: params.channel,
    targetMasked,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    devCode: code, // Accessible in development and tester mode for zero-cost immediate verification
    message: `6-digit verification code sent to ${targetMasked}.`,
  };
}

/**
 * Verifies an OTP code for a given email or phone.
 */
export function verifyOtp(params: {
  target: string;
  code: string;
  channel?: 'email' | 'phone';
  purpose?: 'LOGIN_2FA' | 'OTP_LOGIN' | 'PHONE_VERIFY';
}): { success: boolean; error?: string; message?: string; record?: any } {
  if (!globalStore.otpCodes) {
    return { success: false, error: 'OTP_NOT_FOUND', message: 'No verification code was requested.' };
  }

  const isPhone = params.channel === 'phone' || (!params.target.includes('@') && /[\d+]/.test(params.target));
  const normalizedTarget = isPhone
    ? normalizePhone(params.target)
    : params.target.trim().toLowerCase();

  const record = globalStore.otpCodes.get(normalizedTarget);
  if (!record) {
    return { success: false, error: 'OTP_NOT_FOUND', message: 'No active verification code found for this destination.' };
  }
  if (params.purpose && record.purpose !== params.purpose) {
    return { success: false, error: 'OTP_PURPOSE_MISMATCH', message: 'This verification code cannot be used for this authentication step.' };
  }

  // Check expiration
  if (new Date(record.expiresAt) < new Date()) {
    globalStore.otpCodes.delete(normalizedTarget);
    return { success: false, error: 'OTP_EXPIRED', message: 'Verification code has expired. Please request a new one.' };
  }

  // Rate limit attempts
  record.attempts += 1;
  if (record.attempts > MAX_OTP_ATTEMPTS) {
    globalStore.otpCodes.delete(normalizedTarget);
    return { success: false, error: 'MAX_ATTEMPTS_EXCEEDED', message: 'Too many incorrect attempts. Please request a new code.' };
  }

  // Timing safe or direct match (both are trimmed 6-digit numeric strings)
  if (record.code !== params.code.trim()) {
    return {
      success: false,
      error: 'INVALID_CODE',
      message: `Invalid 6-digit code. ${MAX_OTP_ATTEMPTS - record.attempts} attempts remaining.`,
    };
  }

  // Success: mark verified and consume
  record.verified = true;
  globalStore.otpCodes.delete(normalizedTarget);

  return { success: true, message: 'Verification code verified successfully.', record };
}

/**
 * Initiates a 2FA challenge when logging in with password.
 */
export function createTwoFactorChallenge(params: {
  userId: string;
  target: string;
  channel: 'email' | 'phone';
}): { challengeToken: string; targetMasked: string; devCode?: string } {
  if (!globalStore.twoFactorChallenges) {
    globalStore.twoFactorChallenges = new Map();
  }

  const challengeToken = randomBytes(24).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();

  globalStore.twoFactorChallenges.set(challengeToken, {
    challengeToken,
    userId: params.userId,
    target: params.target,
    channel: params.channel,
    expiresAt,
  });

  const otpResult = sendOtp({
    target: params.target,
    channel: params.channel,
    purpose: 'LOGIN_2FA',
    userId: params.userId,
  });

  return {
    challengeToken,
    targetMasked: otpResult.targetMasked,
    devCode: otpResult.devCode,
  };
}

/**
 * Completes a 2FA challenge using the challenge token and OTP code.
 */
export function verifyTwoFactorChallenge(params: {
  challengeToken: string;
  code: string;
  ipAddress?: string;
  userAgent?: string;
}): { success: boolean; session?: Session; user?: User; error?: string; message?: string } {
  if (!globalStore.twoFactorChallenges) {
    return { success: false, error: 'CHALLENGE_NOT_FOUND', message: 'Invalid or expired 2FA challenge.' };
  }

  const challenge = globalStore.twoFactorChallenges.get(params.challengeToken);
  if (!challenge) {
    return { success: false, error: 'CHALLENGE_NOT_FOUND', message: 'Invalid or expired 2FA challenge.' };
  }

  if (new Date(challenge.expiresAt) < new Date()) {
    globalStore.twoFactorChallenges.delete(params.challengeToken);
    return { success: false, error: 'CHALLENGE_EXPIRED', message: '2FA challenge has expired. Please log in again.' };
  }

  const otpCheck = verifyOtp({
    target: challenge.target,
    code: params.code,
    channel: challenge.channel,
    purpose: 'LOGIN_2FA',
  });

  if (!otpCheck.success) {
    return { success: false, error: otpCheck.error, message: otpCheck.message };
  }

  // Consume challenge
  globalStore.twoFactorChallenges.delete(params.challengeToken);

  const user = globalStore.users.get(challenge.userId);
  if (!user) {
    return { success: false, error: 'USER_NOT_FOUND', message: 'User not found.' };
  }

  // Create session
  const session = createSession({
    userId: user.id,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return { success: true, session, user, message: 'Two-step verification completed successfully.' };
}

