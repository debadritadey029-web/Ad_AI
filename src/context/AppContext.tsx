/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { TRANSLATIONS, SupportedLanguage, TranslationDictionary } from '../i18n/translations.js';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '../lib/supabase.js';

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  avatarUrl?: string;
  twoFactorEnabled?: boolean;
  twoFactorMethod?: 'email' | 'phone' | 'both';
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: string;
  defaultCurrency: string;
  emergencyStopActive: boolean;
  emergencyStopReason?: string;
  emergencyStopTriggeredBy?: string;
  settings: {
    budgetChangeApprovalThresholdMinorUnits: number;
    dailySpendCeilingMinorUnits: number;
    monthlySpendCeilingMinorUnits: number;
    requireFourEyesApproval: boolean;
    brandSafetyStrictness: string;
  };
}

export interface Membership {
  id: string;
  userId: string;
  orgId: string;
  role: string;
  status: string;
}

export interface SupabaseStatusInfo {
  configured: boolean;
  mode: string;
  message: string;
  url?: string;
}

interface AppContextType {
  user: User | null;
  currentOrg: Organization | null;
  membership: Membership | null;
  permissions: string[];
  availableUsers: User[];
  availableOrgs: Organization[];
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  dir: 'ltr' | 'rtl';
  t: (key: keyof TranslationDictionary) => string;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  switchUser: (userId: string) => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  triggerEmergencyStop: (reason: string) => Promise<void>;
  releaseEmergencyStop: () => Promise<void>;
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  refreshContext: () => Promise<void>;
  isLoading: boolean;
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
  sessionToken: string | null;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  showAuthModal: boolean;
  setShowAuthModal: (open: boolean) => void;
  sendOtpRequest: (target: string, channel: 'email' | 'phone') => Promise<{ success: boolean; devCode?: string; targetMasked?: string; message?: string }>;
  loginWithOtp: (target: string, code: string, channel?: 'email' | 'phone') => Promise<boolean>;
  loginWithCredentialsStep1: (email: string, password: string) => Promise<{ requires2FA: boolean; challengeToken?: string; targetMasked?: string; channel?: 'email' | 'phone'; devCode?: string; error?: string }>;
  loginWithCredentialsStep2: (challengeToken: string, code: string) => Promise<boolean>;
  update2FASettings: (settings: { enabled: boolean; method: 'email' | 'phone' | 'both'; phone?: string }) => Promise<boolean>;
  logout: () => Promise<void>;
  supabaseStatus: SupabaseStatusInfo | null;
  checkSupabaseStatus: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [currentOrg, setCurrentOrg] = useState<Organization | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [availableOrgs, setAvailableOrgs] = useState<Organization[]>([]);
  const [language, setLanguageState] = useState<SupportedLanguage>('en');
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    return isSupabaseConfigured ? null : localStorage.getItem('advantage_session_token');
  });

  const authFetch = useCallback(
    async (url: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers || {});
      if (isSupabaseConfigured) {
        const { data } = await getSupabaseBrowserClient().auth.getSession();
        const accessToken = data.session?.access_token;
        if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
      } else if (sessionToken && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${sessionToken}`);
      }
      if (currentOrg?.id && !headers.has('x-organization-id')) {
        headers.set('x-organization-id', currentOrg.id);
      }
      return fetch(url, { ...init, headers });
    },
    [sessionToken, currentOrg?.id]
  );

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 4500);
  }, []);

  const refreshContext = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (isSupabaseConfigured) {
        const { data } = await getSupabaseBrowserClient().auth.getSession();
        if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
      } else if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
      }
      const res = await fetch('/api/auth/context', { headers });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setCurrentOrg(data.currentOrg);
        setMembership(data.membership);
        setPermissions(data.permissions || []);
        setAvailableUsers(data.availableUsers || []);
        setAvailableOrgs(data.availableOrgs || []);
        setShowAuthModal(false);
      } else if (res.status === 401 || res.status === 403) {
        setUser(null);
        setCurrentOrg(null);
        setMembership(null);
        setPermissions([]);
        setAvailableUsers([]);
        setAvailableOrgs([]);
        setShowAuthModal(true);
        if (isSupabaseConfigured) {
          await getSupabaseBrowserClient().auth.signOut();
        } else {
          localStorage.removeItem('advantage_session_token');
          setSessionToken(null);
        }
      }
    } catch (err) {
      console.error('Failed to load auth context:', err);
      showToast('Error connecting to backend services', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [sessionToken, showToast]);

  useEffect(() => {
    refreshContext();
  }, [refreshContext]);

  const setLanguage = (lang: SupportedLanguage) => {
    setLanguageState(lang);
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  };

  const dir: 'ltr' | 'rtl' = language === 'ar' ? 'rtl' : 'ltr';

  const t = (key: keyof TranslationDictionary): string => {
    const dict = TRANSLATIONS[language] || TRANSLATIONS.en;
    return dict[key] || TRANSLATIONS.en[key] || key;
  };

  const switchUser = async (userId: string) => {
    setIsLoading(true);
    try {
      const res = await authFetch('/api/auth/demo-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, orgId: currentOrg?.id }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.token) {
          setSessionToken(data.token);
          localStorage.setItem('advantage_session_token', data.token);
        }
        await refreshContext();
        showToast('Switched user profile successfully', 'success');
      }
    } catch {
      showToast('Failed to switch user', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const switchOrg = async (orgId: string) => {
    setIsLoading(true);
    try {
      const res = await authFetch('/api/auth/switch-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }),
      });
      if (res.ok) {
        await refreshContext();
        showToast('Switched organization workspace', 'success');
      } else {
        const err = await res.json();
        showToast(err.message || 'Failed to switch organization', 'error');
      }
    } catch {
      showToast('Failed to switch organization', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const triggerEmergencyStop = async (reason: string) => {
    try {
      const res = await authFetch('/api/finance/emergency-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'TRIGGER', reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to trigger emergency stop', 'error');
        return;
      }
      await refreshContext();
      showToast('Emergency stop enabled in this workspace. Live provider pausing is not configured.', 'error');
    } catch {
      showToast('Network error triggering emergency stop', 'error');
    }
  };

  const releaseEmergencyStop = async () => {
    try {
      const res = await authFetch('/api/finance/emergency-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'RELEASE' }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to release emergency stop', 'error');
        return;
      }
      await refreshContext();
      showToast('Emergency Stop released. Normal operational safeguards restored.', 'success');
    } catch {
      showToast('Network error releasing emergency stop', 'error');
    }
  };

  const [showAuthModal, setShowAuthModal] = useState<boolean>(true);
  const [supabaseStatus, setSupabaseStatus] = useState<SupabaseStatusInfo | null>(null);

  const checkSupabaseStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/supabase/status');
      if (res.ok) {
        const data = await res.json();
        setSupabaseStatus(data);
      }
    } catch {
      // Offline or network error
    }
  }, []);

  useEffect(() => {
    checkSupabaseStatus();
  }, [checkSupabaseStatus]);

  const sendOtpRequest = async (target: string, channel: 'email' | 'phone') => {
    try {
      if (isSupabaseConfigured) {
        if (channel !== 'email') {
          const message = 'SMS sign-in is not enabled yet. Please use email OTP.';
          showToast(message, 'error');
          return { success: false, message };
        }
        const { error } = await getSupabaseBrowserClient().auth.signInWithOtp({
          email: target.trim().toLowerCase(),
          options: { shouldCreateUser: false },
        });
        if (error) {
          const message = error.message || 'Could not send email verification code.';
          showToast(message, 'error');
          return { success: false, message };
        }
        return { success: true, targetMasked: target.replace(/^(.{2}).*(@.*)$/, '$1••••$2'), message: 'A verification code has been sent to your email.' };
      }

      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, channel }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || data.error || 'Failed to send OTP code', 'error');
        return { success: false, message: data.message };
      }
      return { success: true, devCode: data.devCode, targetMasked: data.targetMasked, message: data.message };
    } catch {
      showToast('Failed to connect to authentication server', 'error');
      return { success: false, message: 'Network connection failure' };
    }
  };

  const loginWithOtp = async (target: string, code: string, channel?: 'email' | 'phone') => {
    setIsLoading(true);
    try {
      if (isSupabaseConfigured) {
        if (channel === 'phone') {
          showToast('SMS sign-in is not enabled yet. Please use email OTP.', 'error');
          return false;
        }
        const { data, error } = await getSupabaseBrowserClient().auth.verifyOtp({
          email: target.trim().toLowerCase(),
          token: code,
          type: 'email',
        });
        if (error || !data.session) {
          showToast(error?.message || 'Invalid or expired verification code.', 'error');
          return false;
        }
        setSessionToken(data.session.access_token);
        localStorage.removeItem('advantage_session_token');
        const contextResponse = await fetch('/api/auth/context', {
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        });
        if (!contextResponse.ok) {
          await getSupabaseBrowserClient().auth.signOut();
          setSessionToken(null);
          const contextError = await contextResponse.json().catch(() => ({}));
          showToast(contextError.message || 'Your account is not provisioned for an AdVantage AI organization. Contact your administrator.', 'error');
          return false;
        }
        const context = await contextResponse.json();
        setUser(context.user);
        setCurrentOrg(context.currentOrg);
        setMembership(context.membership);
        setPermissions(context.permissions || []);
        setAvailableUsers(context.availableUsers || []);
        setAvailableOrgs(context.availableOrgs || []);
        setShowAuthModal(false);
        showToast('Signed in securely with Supabase.', 'success');
        return true;
      }

      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, code, channel }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || data.error || 'Invalid verification code', 'error');
        return false;
      }
      if (data.token) {
        setSessionToken(data.token);
        localStorage.setItem('advantage_session_token', data.token);
      }
      await refreshContext();
      showToast('Two-step authentication verified successfully! Logged in.', 'success');
      setShowAuthModal(false);
      return true;
    } catch {
      showToast('Authentication network error', 'error');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithCredentialsStep1 = async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/login-step1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || data.error || 'Invalid credentials', 'error');
        return { requires2FA: false, error: data.message || 'Invalid credentials' };
      }
      if (!data.requires2FA && data.token) {
        setSessionToken(data.token);
        localStorage.setItem('advantage_session_token', data.token);
        await refreshContext();
        showToast('Signed in successfully', 'success');
        setShowAuthModal(false);
        return { requires2FA: false };
      }
      return {
        requires2FA: true,
        challengeToken: data.challengeToken,
        targetMasked: data.targetMasked,
        channel: data.channel,
        devCode: data.devCode,
      };
    } catch {
      showToast('Network error during authentication', 'error');
      return { requires2FA: false, error: 'Connection failure' };
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithCredentialsStep2 = async (challengeToken: string, code: string) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/login-step2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || data.error || 'Invalid 6-digit code', 'error');
        return false;
      }
      if (data.token) {
        setSessionToken(data.token);
        localStorage.setItem('advantage_session_token', data.token);
      }
      await refreshContext();
      showToast('Two-step verification completed. Welcome back!', 'success');
      setShowAuthModal(false);
      return true;
    } catch {
      showToast('Network error during 2FA verification', 'error');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const update2FASettings = async (settings: { enabled: boolean; method: 'email' | 'phone' | 'both'; phone?: string }) => {
    try {
      const res = await authFetch('/api/auth/2fa/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || 'Failed to update 2FA settings', 'error');
        return false;
      }
      if (data.user) {
        setUser((prev) => (prev ? { ...prev, ...data.user } : prev));
      }
      showToast('Two-Step security preferences updated', 'success');
      return true;
    } catch {
      showToast('Failed to save security settings', 'error');
      return false;
    }
  };

  const logout = async () => {
    try {
      if (isSupabaseConfigured) {
        await getSupabaseBrowserClient().auth.signOut();
      } else {
        await authFetch('/api/auth/logout', { method: 'POST' });
      }
    } catch {
      // Clear the local UI session even if the network is unavailable.
    }
    localStorage.removeItem('advantage_session_token');
    setSessionToken(null);
    setUser(null);
    setCurrentOrg(null);
    setMembership(null);
    setPermissions([]);
    setAvailableUsers([]);
    setAvailableOrgs([]);
    showToast('Logged out of session', 'info');
    setShowAuthModal(true);
  };

  return (
    <AppContext.Provider
      value={{
        user,
        currentOrg,
        membership,
        permissions,
        availableUsers,
        availableOrgs,
        language,
        setLanguage,
        dir,
        t,
        activeTab,
        setActiveTab,
        switchUser,
        switchOrg,
        triggerEmergencyStop,
        releaseEmergencyStop,
        toast,
        showToast,
        refreshContext,
        isLoading,
        mobileMenuOpen,
        setMobileMenuOpen,
        sessionToken,
        authFetch,
        showAuthModal,
        setShowAuthModal,
        sendOtpRequest,
        loginWithOtp,
        loginWithCredentialsStep1,
        loginWithCredentialsStep2,
        update2FASettings,
        logout,
        supabaseStatus,
        checkSupabaseStatus,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
