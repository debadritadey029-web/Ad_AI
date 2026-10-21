/** Security-mode helpers. Demo shortcuts are opt-in and never available in production. */
export const isProduction = (): boolean => process.env.NODE_ENV === 'production';
export const isDemoAuthEnabled = (): boolean =>
  !isProduction() && process.env.ENABLE_DEMO_AUTH === 'true';
export const shouldExposeDevOtpCode = (): boolean =>
  !isProduction() && process.env.ENABLE_DEV_OTP_CODE === 'true';
