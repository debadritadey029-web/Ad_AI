/**
 * Security-mode helpers. Demo shortcuts are opt-in for isolated staging only and
 * are never enabled on a production deployment.
 */
export const isProduction = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
  appEnv: string | undefined = process.env.APP_ENV,
  vercelEnv: string | undefined = process.env.VERCEL_ENV
): boolean => {
  if (vercelEnv === 'production') return true;
  if (vercelEnv === 'preview' || appEnv === 'staging') return false;
  return nodeEnv === 'production';
};

export const isDemoAuthEnabled = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
  enabled: string | undefined = process.env.ENABLE_DEMO_AUTH,
  appEnv: string | undefined = process.env.APP_ENV,
  vercelEnv: string | undefined = process.env.VERCEL_ENV
): boolean => !isProduction(nodeEnv, appEnv, vercelEnv) && enabled === 'true';

export const shouldExposeDevOtpCode = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
  enabled: string | undefined = process.env.ENABLE_DEV_OTP_CODE,
  appEnv: string | undefined = process.env.APP_ENV,
  vercelEnv: string | undefined = process.env.VERCEL_ENV
): boolean => !isProduction(nodeEnv, appEnv, vercelEnv) && enabled === 'true';
