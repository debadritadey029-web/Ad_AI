/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Role =
  | 'OWNER'
  | 'ADMIN'
  | 'CAMPAIGN_MANAGER'
  | 'ANALYST'
  | 'CREATIVE'
  | 'FINANCE_APPROVER'
  | 'OPERATOR'
  | 'READ_ONLY';

export type Permission =
  | 'MANAGE_ORGS'
  | 'INVITE_MEMBERS'
  | 'MANAGE_ROLES'
  | 'CREATE_CAMPAIGNS'
  | 'EDIT_CAMPAIGNS'
  | 'DELETE_CAMPAIGNS'
  | 'APPROVE_BUDGETS'
  | 'TRIGGER_EMERGENCY_STOP'
  | 'RELEASE_EMERGENCY_STOP'
  | 'EXECUTE_PROVIDER_WRITES'
  | 'CONNECT_PROVIDERS'
  | 'VIEW_ANALYTICS'
  | 'EXPORT_DATA'
  | 'MANAGE_CREATIVES'
  | 'MANAGE_LEADS'
  | 'USE_COPILOT'
  | 'VIEW_AUDIT_LOGS';

export interface User {
  id: string;
  email: string;
  phone?: string;
  name: string;
  avatarUrl?: string;
  passwordHash?: string;
  passwordSalt?: string;
  twoFactorEnabled?: boolean;
  twoFactorMethod?: 'email' | 'phone' | 'both';
  createdAt: string;
}

export interface Session {
  id: string;
  token: string;
  userId: string;
  activeOrgId: string;
  createdAt: string;
  expiresAt: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: 'ENTERPRISE' | 'GROWTH' | 'STARTER';
  defaultCurrency: string; // 'USD', 'EUR', 'INR', 'GBP', 'JPY'
  emergencyStopActive: boolean;
  emergencyStopReason?: string;
  emergencyStopTriggeredAt?: string;
  emergencyStopTriggeredBy?: string;
  settings: {
    budgetChangeApprovalThresholdMinorUnits: number; // e.g. 50000 = $500.00
    dailySpendCeilingMinorUnits: number;
    monthlySpendCeilingMinorUnits: number;
    requireFourEyesApproval: boolean;
    brandSafetyStrictness: 'STRICT' | 'STANDARD' | 'LENIENT';
  };
  createdAt: string;
}

export interface Membership {
  id: string;
  userId: string;
  orgId: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  joinedAt: string;
}

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: Role;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  createdAt: string;
}

export type ProviderType =
  | 'meta'
  | 'google'
  | 'tiktok'
  | 'linkedin'
  | 'microsoft'
  | 'pinterest'
  | 'snapchat'
  | 'reddit'
  | 'x'
  | 'apple';

export interface ProviderConnection {
  id: string;
  orgId: string;
  provider: ProviderType;
  accountId: string;
  accountName: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'NEEDS_REAUTH' | 'SANDBOX';
  environment: 'PRODUCTION' | 'SANDBOX';
  capabilities: {
    canReadCampaigns: boolean;
    canWriteCampaigns: boolean;
    canReadMetrics: boolean;
    supportsWebhooks: boolean;
    supportsLeads: boolean;
  };
  lastSyncAt: string;
  syncStatus: 'HEALTHY' | 'SYNCING' | 'ERROR';
  errorMessage?: string;
  apiQuotaUsedPercent: number;
}

export type CampaignObjective =
  | 'AWARENESS'
  | 'TRAFFIC'
  | 'ENGAGEMENT'
  | 'LEADS'
  | 'APP_PROMOTION'
  | 'CONVERSIONS';

export type CampaignStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'REJECTED';

export interface TargetingSpec {
  locations: string[];
  ageMin: number;
  ageMax: number;
  genders: ('ALL' | 'MALE' | 'FEMALE')[];
  interests?: string[];
  keywords?: string[];
  languages?: string[];
}

export interface Campaign {
  id: string;
  orgId: string;
  provider: ProviderType;
  providerAccountId: string;
  providerCampaignId?: string;
  name: string;
  objective: CampaignObjective;
  status: CampaignStatus;
  budgetType: 'DAILY' | 'LIFETIME';
  budgetMinorUnits: number; // stored as integer in minor units (e.g. 150000 for $1500.00)
  currency: string;
  startDate: string;
  endDate?: string;
  targeting: TargetingSpec;
  adGroupCount: number;
  creativeIds: string[];
  actualSpendMinorUnits: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueMinorUnits: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type ProposalType =
  | 'CAMPAIGN_CREATE'
  | 'BUDGET_INCREASE'
  | 'BUDGET_DECREASE'
  | 'CAMPAIGN_STATUS_CHANGE'
  | 'EMERGENCY_STOP_OVERRIDE';

export type ProposalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTED'
  | 'CANCELLED'
  | 'STALE';

export interface BudgetProposal {
  id: string;
  orgId: string;
  campaignId: string;
  type: ProposalType;
  title: string;
  description: string;
  requestedByUserId: string;
  requestedAt: string;
  reviewedByUserId?: string;
  reviewedAt?: string;
  status: ProposalStatus;
  currentBudgetMinorUnits: number;
  proposedBudgetMinorUnits: number;
  currency: string;
  reason: string;
  campaignVersionAtRequest: number;
  reviewNotes?: string;
}

export interface CreativeAsset {
  id: string;
  orgId: string;
  name: string;
  brandProfileId: string;
  headline: string;
  description: string;
  callToAction: string;
  targetUrl: string;
  platformFormats: ProviderType[];
  language: string; // 'en', 'hi', 'es', 'fr', 'ar'
  status: 'DRAFT' | 'APPROVED' | 'IN_REVIEW' | 'ARCHIVED';
  brandSafetyScore: number; // 0 - 100
  brandSafetyNotes: string[];
  imageUrl?: string;
  createdAt: string;
}

export interface BrandProfile {
  id: string;
  orgId: string;
  name: string;
  industry: string;
  tone: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl?: string;
  disallowedKeywords: string[];
  keySellingPoints: string[];
}

export interface LeadRecord {
  id: string;
  orgId: string;
  channel: 'WHATSAPP' | 'INSTAGRAM' | 'FACEBOOK_MESSENGER' | 'META_INSTANT_FORM';
  contactName: string;
  contactIdentifier: string; // phone or IG handle
  status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'DISQUALIFIED';
  campaignId?: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  messagingWindowExpiresAt: string; // 24h window for WhatsApp / Meta
  consentOptIn: boolean;
  assignedToUserId?: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  orgId: string;
  actorUserId: string;
  actorEmail: string;
  actorRole: Role;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  timestamp: string;
  prevHash: string;
  hash: string; // SHA-256 tamper-evident integrity hash
}

export interface OtpRecord {
  id: string;
  target: string; // email or normalized phone number
  channel: 'email' | 'phone';
  code: string;
  purpose: 'LOGIN_2FA' | 'OTP_LOGIN' | 'PHONE_VERIFY';
  userId?: string;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  verified: boolean;
}

export interface TwoFactorChallenge {
  challengeToken: string;
  userId: string;
  target: string;
  channel: 'email' | 'phone';
  expiresAt: string;
}

export interface DataStore {
  users: Map<string, User>;
  organizations: Map<string, Organization>;
  memberships: Map<string, Membership>;
  invitations: Map<string, Invitation>;
  providerConnections: Map<string, ProviderConnection>;
  campaigns: Map<string, Campaign>;
  proposals: Map<string, BudgetProposal>;
  creatives: Map<string, CreativeAsset>;
  brandProfiles: Map<string, BrandProfile>;
  leads: Map<string, LeadRecord>;
  auditLogs: AuditLogEntry[];
  sessions: Map<string, Session>;
  otpCodes?: Map<string, OtpRecord>;
  twoFactorChallenges?: Map<string, TwoFactorChallenge>;
}
