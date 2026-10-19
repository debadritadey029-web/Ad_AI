/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  createSession,
  validateSessionToken,
  revokeSession,
  generateSessionToken,
  normalizePhone,
  maskContact,
  sendOtp,
  verifyOtp,
  createTwoFactorChallenge,
  verifyTwoFactorChallenge,
} from '../services/auth.js';

test('Auth: password hashing and verification with scrypt', () => {
  const password = 'EnterprisePassword2026!';
  const { salt, hash } = hashPassword(password);

  assert.ok(salt.length >= 32);
  assert.ok(hash.length >= 64);

  // Correct password verification
  assert.equal(verifyPassword(password, salt, hash), true);

  // Incorrect password rejection
  assert.equal(verifyPassword('WrongPassword123!', salt, hash), false);

  // Empty or tampered hash rejection
  assert.equal(verifyPassword(password, salt, '0000000000000000'), false);
});

test('Auth: session token creation, validation, and revocation', () => {
  const session = createSession({
    userId: 'usr_sarah',
    activeOrgId: 'org_apex',
    userAgent: 'IntegrationTestRunner/1.0',
    ipAddress: '127.0.0.1',
  });

  assert.ok(session.token);
  assert.equal(session.userId, 'usr_sarah');
  assert.equal(session.activeOrgId, 'org_apex');

  // Validate session token
  const retrieved = validateSessionToken(session.token);
  assert.ok(retrieved);
  assert.equal(retrieved?.userId, 'usr_sarah');

  // Invalidate session on logout
  const revoked = revokeSession(session.token);
  assert.equal(revoked, true);

  // Subsequent validation fails
  const afterRevoke = validateSessionToken(session.token);
  assert.equal(afterRevoke, null);
});

test('Auth: high-entropy session tokens are unique', () => {
  const token1 = generateSessionToken();
  const token2 = generateSessionToken();
  assert.notEqual(token1, token2);
  assert.equal(token1.length, 64);
});

test('Auth 2FA: normalizePhone standardizes phone numbers', () => {
  assert.equal(normalizePhone('+1 (555) 234-5678'), '+15552345678');
  assert.equal(normalizePhone('5552345678'), '+15552345678');
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
});

test('Auth 2FA: maskContact protects user privacy', () => {
  const maskedEmail = maskContact('sarah.jenkins@advantage-ai.enterprise', 'email');
  assert.ok(maskedEmail.includes('••••'));
  assert.ok(maskedEmail.endsWith('@advantage-ai.enterprise'));

  const maskedPhone = maskContact('+15552345678', 'phone');
  assert.ok(maskedPhone.includes('••••'));
  assert.ok(maskedPhone.endsWith('5678'));
});

test('Auth 2FA: sendOtp and verifyOtp lifecycle for Email and Phone', () => {
  // 1. Send OTP to Email
  const emailRes = sendOtp({
    target: 'test.user@enterprise.com',
    channel: 'email',
    purpose: 'OTP_LOGIN',
  });
  assert.equal(emailRes.success, true);
  assert.ok(emailRes.devCode);
  assert.equal(emailRes.devCode.length, 6);

  // 2. Incorrect code is rejected
  const badVerify = verifyOtp({
    target: 'test.user@enterprise.com',
    code: '000000',
    channel: 'email',
  });
  assert.equal(badVerify.success, false);

  // 3. Correct code is verified
  const goodVerify = verifyOtp({
    target: 'test.user@enterprise.com',
    code: emailRes.devCode,
    channel: 'email',
  });
  assert.equal(goodVerify.success, true);

  // 4. Code cannot be reused
  const replayVerify = verifyOtp({
    target: 'test.user@enterprise.com',
    code: emailRes.devCode,
    channel: 'email',
  });
  assert.equal(replayVerify.success, false);
});

test('Auth 2FA: Two-step challenge lifecycle for password credentials', () => {
  const challenge = createTwoFactorChallenge({
    userId: 'usr_sarah',
    target: 'sarah.jenkins@advantage-ai.enterprise',
    channel: 'email',
  });

  assert.ok(challenge.challengeToken);
  assert.ok(challenge.devCode);

  // Complete challenge
  const res = verifyTwoFactorChallenge({
    challengeToken: challenge.challengeToken,
    code: challenge.devCode!,
  });

  assert.equal(res.success, true);
  assert.ok(res.session);
  assert.equal(res.session?.userId, 'usr_sarah');
});

