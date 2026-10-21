import test from 'node:test';
import assert from 'node:assert/strict';
import { isProduction, isDemoAuthEnabled, shouldExposeDevOtpCode } from '../services/security-mode.js';

test('Security mode: production always disables demo authentication', () => {
  assert.equal(isProduction('production'), true);
  assert.equal(isDemoAuthEnabled('production', 'true'), false);
});

test('Security mode: demo authentication requires an explicit non-production opt-in', () => {
  assert.equal(isDemoAuthEnabled('development', undefined), false);
  assert.equal(isDemoAuthEnabled('development', 'true'), true);
  assert.equal(isDemoAuthEnabled('test', 'true'), true);
  assert.equal(isDemoAuthEnabled('production', 'true'), false);
});

test('Security mode: development OTP codes require explicit opt-in and are never exposed in production', () => {
  assert.equal(shouldExposeDevOtpCode('development', undefined), false);
  assert.equal(shouldExposeDevOtpCode('development', 'true'), true);
  assert.equal(shouldExposeDevOtpCode('production', 'true'), false);
});
