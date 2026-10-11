export type CorsPolicy = { origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => void; credentials: false };

export function createCorsPolicy(env: NodeJS.ProcessEnv = process.env): CorsPolicy {
  const production = env.NODE_ENV === 'production';
  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('CORS_ORIGINS must contain absolute origins only.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password)
      throw new Error('CORS_ORIGINS must contain origin values without paths or credentials.');
    if (production && url.protocol !== 'https:') throw new Error('Production CORS_ORIGINS must use HTTPS.');
  }
  if (production && origins.length === 0) throw new Error('Set CORS_ORIGINS to the exact production frontend origin.');

  return {
    credentials: false,
    origin(origin, callback) {
      // Non-browser agent requests have no Origin. Development preserves the existing
      // permissive local workflow unless a local allowlist is explicitly configured.
      if (!origin || (!production && origins.length === 0)) return callback(null, true);
      callback(null, origins.includes(origin));
    },
  };
}
