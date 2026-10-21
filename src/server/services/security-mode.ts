/** Security-mode helpers. Demo shortcuts are opt-in and never available in production. */
export const isProduction = (nodeEnv: string | undefined = process.env.NODE_ENV): boolean => nodeEnv === 'production';
export const isDemoAuthEnabled = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
  enabled: string | undefined = process.env.ENABLE_DEMO_AUTH
): boolean => nodeEnv !== 'production' && enabled === 'true';
export const shouldExposeDevOtpCode = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
  enabled: string | undefined = process.env.ENABLE_DEV_OTP_CODE
): boolean => nodeEnv !== 'production' && enabled === 'true';
