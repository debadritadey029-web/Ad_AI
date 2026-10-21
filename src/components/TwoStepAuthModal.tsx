/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext.js';
import { isSupabaseConfigured } from '../lib/supabase.js';
import {
  ShieldCheck,
  ShieldAlert,
  Mail,
  Phone,
  KeyRound,
  Lock,
  Copy,
  Check,
  RotateCw,
  Database,
  ArrowRight,
  Sparkles,
  X,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';

interface TwoStepAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const COUNTRY_CODES = [
  { code: '+1', country: 'US/CA', flag: '🇺🇸' },
  { code: '+91', country: 'IN', flag: '🇮🇳' },
  { code: '+44', country: 'UK', flag: '🇬🇧' },
  { code: '+49', country: 'DE', flag: '🇩🇪' },
  { code: '+33', country: 'FR', flag: '🇫🇷' },
  { code: '+81', country: 'JP', flag: '🇯🇵' },
  { code: '+61', country: 'AU', flag: '🇦🇺' },
  { code: '+971', country: 'AE', flag: '🇦🇪' },
];

export const TwoStepAuthModal: React.FC<TwoStepAuthModalProps> = ({ isOpen, onClose }) => {
  const {
    user,
    sendOtpRequest,
    loginWithOtp,
    loginWithCredentialsStep1,
    loginWithCredentialsStep2,
    update2FASettings,
    supabaseStatus,
    checkSupabaseStatus,
    showToast,
  } = useApp();

  const [activeTab, setActiveTab] = useState<'LOGIN' | 'SETTINGS' | 'SUPABASE'>('LOGIN');

  // Step state: 1 = Enter contact / credentials, 2 = Enter 6-digit OTP
  const [currentStep, setCurrentStep] = useState<1 | 2>(1);
  const [authMode, setAuthMode] = useState<'OTP_DIRECT' | 'PASSWORD_2FA'>('OTP_DIRECT');
  const [channel, setChannel] = useState<'email' | 'phone'>('email');

  // Inputs
  const [emailInput, setEmailInput] = useState('');
  const [countryCode, setCountryCode] = useState('+1');
  const [phoneInput, setPhoneInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  // 2FA Challenge state
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [targetMasked, setTargetMasked] = useState<string>('');
  const [devCode, setDevCode] = useState<string | null>(null);

  // 6-digit OTP input array
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [timerSeconds, setTimerSeconds] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [copiedSchema, setCopiedSchema] = useState(false);

  // Settings state
  const [twoFactorToggle, setTwoFactorToggle] = useState<boolean>(user?.twoFactorEnabled ?? true);
  const [preferredMethod, setPreferredMethod] = useState<'email' | 'phone' | 'both'>(
    user?.twoFactorMethod ?? 'both'
  );
  const [settingsPhone, setSettingsPhone] = useState<string>(user?.phone || '');

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Timer countdown
  useEffect(() => {
    if (timerSeconds <= 0) return;
    const interval = setInterval(() => {
      setTimerSeconds((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [timerSeconds]);

  // Sync settings when user changes
  useEffect(() => {
    if (user) {
      setTwoFactorToggle(user.twoFactorEnabled ?? true);
      setPreferredMethod(user.twoFactorMethod ?? 'both');
      setSettingsPhone(user.phone || '');
    }
  }, [user]);

  if (!isOpen) return null;

  const getFullPhone = () => {
    const cleaned = phoneInput.replace(/[^\d]/g, '');
    return `${countryCode}${cleaned}`;
  };

  const handleSendOtpDirect = async () => {
    setIsSubmitting(true);
    const target = channel === 'email' ? emailInput.trim() : getFullPhone();

    if (channel === 'email' && (!target || !target.includes('@'))) {
      showToast('Please enter a valid email address.', 'error');
      setIsSubmitting(false);
      return;
    }
    if (channel === 'phone' && phoneInput.trim().length < 7) {
      showToast('Please enter a valid mobile phone number.', 'error');
      setIsSubmitting(false);
      return;
    }

    const result = await sendOtpRequest(target, channel);
    setIsSubmitting(false);

    if (result.success) {
      setTargetMasked(result.targetMasked || target);
      setDevCode(result.devCode || null);
      setCurrentStep(2);
      setTimerSeconds(60);
      setOtpDigits(['', '', '', '', '', '']);
      setTimeout(() => inputRefs.current[0]?.focus(), 150);
    }
  };

  const handlePasswordStep1 = async () => {
    if (!emailInput.trim() || !passwordInput) {
      showToast('Please enter your email and password.', 'error');
      return;
    }

    setIsSubmitting(true);
    const res = await loginWithCredentialsStep1(emailInput.trim(), passwordInput);
    setIsSubmitting(false);

    if (res.requires2FA) {
      setChallengeToken(res.challengeToken || null);
      setTargetMasked(res.targetMasked || emailInput);
      setDevCode(res.devCode || null);
      setCurrentStep(2);
      setTimerSeconds(60);
      setOtpDigits(['', '', '', '', '', '']);
      setTimeout(() => inputRefs.current[0]?.focus(), 150);
    }
  };

  const handleVerifyOtp = async () => {
    const fullCode = otpDigits.join('');
    if (fullCode.length !== 6) {
      showToast('Please enter all 6 digits of the verification code.', 'error');
      return;
    }

    setIsSubmitting(true);

    if (authMode === 'PASSWORD_2FA' && challengeToken) {
      // Step 2 of password + 2FA
      const success = await loginWithCredentialsStep2(challengeToken, fullCode);
      setIsSubmitting(false);
      if (success) onClose();
    } else {
      // Step 2 of direct OTP
      const target = channel === 'email' ? emailInput.trim() : getFullPhone();
      const success = await loginWithOtp(target, fullCode, channel);
      setIsSubmitting(false);
      if (success) onClose();
    }
  };

  const handleDigitChange = (index: number, val: string) => {
    const digit = val.slice(-1).replace(/[^\d]/g, '');
    const newDigits = [...otpDigits];
    newDigits[index] = digit;
    setOtpDigits(newDigits);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePasteOtp = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const paste = e.clipboardData.getData('text').replace(/[^\d]/g, '').slice(0, 6);
    if (paste.length > 0) {
      const newDigits = [...otpDigits];
      for (let i = 0; i < 6; i++) {
        newDigits[i] = paste[i] || '';
      }
      setOtpDigits(newDigits);
      const focusIndex = Math.min(paste.length, 5);
      inputRefs.current[focusIndex]?.focus();
    }
  };

  const handleSaveSecuritySettings = async () => {
    setIsSubmitting(true);
    await update2FASettings({
      enabled: twoFactorToggle,
      method: preferredMethod,
      phone: settingsPhone,
    });
    setIsSubmitting(false);
  };

  const selectDemoUser = (userType: 'SARAH' | 'MARCUS' | 'PRIYA') => {
    if (userType === 'SARAH') {
      setEmailInput('sarah.jenkins@advantage-ai.enterprise');
      setPasswordInput('AdvantageTest2026!');
      setCountryCode('+1');
      setPhoneInput('5552345678');
    } else if (userType === 'MARCUS') {
      setEmailInput('marcus.vance@advantage-ai.enterprise');
      setPasswordInput('AdvantageTest2026!');
      setCountryCode('+1');
      setPhoneInput('5553456789');
    } else {
      setEmailInput('priya.sharma@advantage-ai.enterprise');
      setPasswordInput('AdvantageTest2026!');
      setCountryCode('+91');
      setPhoneInput('9876543210');
    }
  };

  const copySupabaseSchema = () => {
    const schemaSql = `-- 1-Click Supabase Schema for AdVantage AI
-- Run this in your Supabase Dashboard -> SQL Editor!
-- File located at /supabase/schema.sql in this repository.`;
    navigator.clipboard.writeText(schemaSql);
    setCopiedSchema(true);
    showToast('SQL Schema instructions copied to clipboard!', 'success');
    setTimeout(() => setCopiedSchema(false), 3000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-xl w-full shadow-2xl overflow-hidden relative animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-sky-400 flex items-center justify-center shadow-lg shadow-blue-500/20 text-white font-black text-lg">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  Two-Step Authentication & Security
                </h2>
                <span className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full">
                  FREE TIER
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Email & Phone OTP • Supabase Cloud DB • Vercel Ready
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
            aria-label="Close authentication modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="px-6 pt-4 border-b border-slate-800 flex gap-2 text-xs font-semibold">
          <button
            onClick={() => {
              setActiveTab('LOGIN');
              setCurrentStep(1);
            }}
            className={`pb-3 px-3 border-b-2 transition ${
              activeTab === 'LOGIN'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            2-Step Login & OTP
          </button>
          <button
            onClick={() => setActiveTab('SETTINGS')}
            className={`pb-3 px-3 border-b-2 transition ${
              activeTab === 'SETTINGS'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Security & 2FA Settings
          </button>
          <button
            onClick={() => {
              setActiveTab('SUPABASE');
              checkSupabaseStatus();
            }}
            className={`pb-3 px-3 border-b-2 transition ${
              activeTab === 'SUPABASE'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Supabase DB Sync
          </button>
        </div>

        {/* Tab 1: 2-Step Login */}
        {activeTab === 'LOGIN' && (
          <div className="p-6">
            {/* Step 1: Input Contact or Password */}
            {currentStep === 1 && (
              <div className="space-y-4">
                {/* Method selector */}
                <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
                  <button
                    onClick={() => setAuthMode('OTP_DIRECT')}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${
                      authMode === 'OTP_DIRECT'
                        ? 'bg-blue-600 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Direct OTP (Passwordless)
                  </button>
                  {!isSupabaseConfigured && (<button
                    onClick={() => setAuthMode('PASSWORD_2FA')}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${
                      authMode === 'PASSWORD_2FA'
                        ? 'bg-blue-600 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Password + 2-Step OTP
                  </button>)}
                </div>

                {authMode === 'OTP_DIRECT' ? (
                  <>
                    {/* Channel Toggle */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setChannel('email')}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl border text-xs font-medium transition ${
                          channel === 'email'
                            ? 'bg-blue-500/10 border-blue-500/50 text-blue-400'
                            : 'bg-slate-800/40 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <Mail className="w-4 h-4" />
                        <span>Email OTP</span>
                      </button>
                      {!isSupabaseConfigured && (<button
                        onClick={() => setChannel('phone')}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-xl border text-xs font-medium transition ${
                          channel === 'phone'
                            ? 'bg-blue-500/10 border-blue-500/50 text-blue-400'
                            : 'bg-slate-800/40 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <Phone className="w-4 h-4" />
                        <span>SMS Phone OTP</span>
                      </button>)}
                    </div>

                    {/* Email or Phone Input */}
                    {channel === 'email' ? (
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                          Work or Personal Email
                        </label>
                        <div className="relative">
                          <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                          <input
                            type="email"
                            placeholder="name@company.com"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                          />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                          Mobile Phone Number (SMS)
                        </label>
                        <div className="flex gap-2">
                          <select
                            value={countryCode}
                            onChange={(e) => setCountryCode(e.target.value)}
                            className="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500"
                          >
                            {COUNTRY_CODES.map((c) => (
                              <option key={c.code} value={c.code}>
                                {c.flag} {c.code}
                              </option>
                            ))}
                          </select>
                          <div className="relative flex-1">
                            <Phone className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                            <input
                              type="tel"
                              placeholder="555-234-5678"
                              value={phoneInput}
                              onChange={(e) => setPhoneInput(e.target.value)}
                              className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={handleSendOtpDirect}
                      disabled={isSubmitting}
                      className="w-full py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                    >
                      {isSubmitting ? (
                        <RotateCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <span>Send 6-Digit Verification Code</span>
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    {/* Password + 2FA Mode */}
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                        Enterprise Email
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                        <input
                          type="email"
                          placeholder="sarah.jenkins@advantage-ai.enterprise"
                          value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                        Password
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                        <input
                          type="password"
                          placeholder="••••••••••••"
                          value={passwordInput}
                          onChange={(e) => setPasswordInput(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                        />
                      </div>
                    </div>

                    <button
                      onClick={handlePasswordStep1}
                      disabled={isSubmitting}
                      className="w-full py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                    >
                      {isSubmitting ? (
                        <RotateCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <span>Verify Credentials & Request OTP</span>
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </>
                )}

                {!isSupabaseConfigured && (
                {/* Tester Quick Pre-fill helpers */}
                <div className="mt-4 pt-4 border-t border-slate-800/80">
                  <p className="text-[11px] font-semibold text-slate-400 mb-2">
                    Quick-Fill Authorized Test Profiles (Instant 2-Step Testing):
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => selectDemoUser('SARAH')}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[11px] font-medium border border-slate-700/60"
                    >
                      Sarah Jenkins (Owner, 2FA Active)
                    </button>
                    <button
                      onClick={() => selectDemoUser('MARCUS')}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[11px] font-medium border border-slate-700/60"
                    >
                      Marcus Vance (Admin, Phone 2FA)
                    </button>
                    <button
                      onClick={() => selectDemoUser('PRIYA')}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[11px] font-medium border border-slate-700/60"
                    >
                      Priya Sharma (+91 Phone)
                    </button>
                  </div>
                </div>
                )}
              </div>
            )}

            {/* Step 2: 6-Digit OTP Verification */}
            {currentStep === 2 && (
              <div className="space-y-5 text-center">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-inner">
                  <KeyRound className="w-6 h-6" />
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">
                    Enter Verification Code
                  </h3>
                  <p className="text-xs text-slate-400">
                    We sent a 6-digit code to{' '}
                    <span className="font-semibold text-blue-300">{targetMasked}</span>
                  </p>
                </div>

                {/* Dev Code Helper for free immediate testing */}
                {devCode && (
                  <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-2.5 text-xs text-emerald-300 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-emerald-400" />
                      <span>
                        Test Code: <strong className="font-mono text-sm tracking-wider">{devCode}</strong>
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        const digits = devCode.split('').slice(0, 6);
                        setOtpDigits(digits);
                        showToast('Test code auto-filled!', 'success');
                      }}
                      className="bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 px-2 py-0.5 rounded text-[11px] font-semibold"
                    >
                      Auto-Fill
                    </button>
                  </div>
                )}

                {/* 6 Segmented Digit Inputs */}
                <div className="flex justify-center gap-2 sm:gap-3">
                  {otpDigits.map((digit, index) => (
                    <input
                      key={index}
                      ref={(el) => {
                        inputRefs.current[index] = el;
                      }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(index, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(index, e)}
                      onPaste={handlePasteOtp}
                      className="w-10 h-12 sm:w-12 sm:h-14 bg-slate-950 border border-slate-700 rounded-xl text-center text-xl font-mono font-bold text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-inner"
                    />
                  ))}
                </div>

                <div className="flex items-center justify-between text-xs text-slate-400">
                  <button
                    onClick={() => setCurrentStep(1)}
                    className="text-slate-400 hover:text-white transition"
                  >
                    ← Change Email/Phone
                  </button>

                  {timerSeconds > 0 ? (
                    <span className="text-slate-500">Resend code in {timerSeconds}s</span>
                  ) : (
                    <button
                      onClick={handleSendOtpDirect}
                      className="text-blue-400 hover:underline font-semibold"
                    >
                      Resend Code
                    </button>
                  )}
                </div>

                <button
                  onClick={handleVerifyOtp}
                  disabled={isSubmitting || otpDigits.join('').length !== 6}
                  className="w-full py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <RotateCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <span>Verify & Authenticate</span>
                      <Check className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Security & 2FA Settings */}
        {activeTab === 'SETTINGS' && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between p-3.5 bg-slate-950 rounded-2xl border border-slate-800">
              <div className="flex items-center gap-3">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                    twoFactorToggle ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white">Require Two-Step Verification (2FA)</h4>
                  <p className="text-[11px] text-slate-400">
                    Require OTP verification upon every login or critical financial action.
                  </p>
                </div>
              </div>
              <input
                type="checkbox"
                checked={twoFactorToggle}
                onChange={(e) => setTwoFactorToggle(e.target.checked)}
                className="w-5 h-5 accent-blue-600 rounded cursor-pointer"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Primary Two-Step Channel
              </label>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <button
                  onClick={() => setPreferredMethod('email')}
                  className={`py-2 px-3 rounded-xl border text-center font-medium transition ${
                    preferredMethod === 'email'
                      ? 'bg-blue-500/10 border-blue-500 text-blue-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  Email Only
                </button>
                <button
                  onClick={() => setPreferredMethod('phone')}
                  className={`py-2 px-3 rounded-xl border text-center font-medium transition ${
                    preferredMethod === 'phone'
                      ? 'bg-blue-500/10 border-blue-500 text-blue-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  Phone / SMS Only
                </button>
                <button
                  onClick={() => setPreferredMethod('both')}
                  className={`py-2 px-3 rounded-xl border text-center font-medium transition ${
                    preferredMethod === 'both'
                      ? 'bg-blue-500/10 border-blue-500 text-blue-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  Both (Fallback)
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Registered Mobile Phone
              </label>
              <input
                type="tel"
                value={settingsPhone}
                onChange={(e) => setSettingsPhone(e.target.value)}
                placeholder="+1 (555) 234-5678"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Used to deliver 6-digit SMS OTPs for high-security actions and budget approvals.
              </p>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={handleSaveSecuritySettings}
                disabled={isSubmitting}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5"
              >
                {isSubmitting ? <RotateCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span>Save 2FA Settings</span>
              </button>
            </div>
          </div>
        )}

        {/* Tab 3: Supabase Sync Status */}
        {activeTab === 'SUPABASE' && (
          <div className="p-6 space-y-4">
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-bold text-white">Supabase Cloud Database Status</span>
                </div>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                    supabaseStatus?.configured
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  }`}
                >
                  {supabaseStatus?.configured ? 'CONNECTED' : 'LOCAL PERSISTENT STORE'}
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                {supabaseStatus?.message ||
                  'The application is using atomic persistent store synchronization. Connect your Supabase project in 1 minute using the free tier.'}
              </p>

              {supabaseStatus?.url && (
                <div className="text-[11px] font-mono text-slate-300 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 flex items-center justify-between">
                  <span>Project: {supabaseStatus.url}</span>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                </div>
              )}
            </div>

            {/* SQL Schema 1-click execution */}
            <div className="border border-slate-800 rounded-2xl p-4 bg-slate-950/60">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-white">Supabase SQL Migration File</h4>
                <button
                  onClick={copySupabaseSchema}
                  className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700 transition"
                >
                  {copiedSchema ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedSchema ? 'Copied!' : 'Copy Schema SQL'}</span>
                </button>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                A ready-to-run schema file is saved at <code className="text-blue-300">/supabase/schema.sql</code>. It creates all tables (<code className="text-slate-300">users</code>, <code className="text-slate-300">organizations</code>, <code className="text-slate-300">campaigns</code>, <code className="text-slate-300">otp_codes</code>, <code className="text-slate-300">audit_logs</code>), sets up Row Level Security (RLS), and seeds initial data.
              </p>
            </div>

            <div className="flex justify-between items-center pt-1 text-xs">
              <a
                href="https://supabase.com/dashboard"
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 hover:underline flex items-center gap-1 font-semibold"
              >
                <span>Open Supabase Dashboard</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button
                onClick={checkSupabaseStatus}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-semibold flex items-center gap-1.5 transition"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Re-Check Status</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
