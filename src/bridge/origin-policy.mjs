const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export const normalizeOrigin = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;
  if (value === 'null' || value === '*') return null;

  try {
    const parsed = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
};

export const requireAllowedOrigin = (value) => {
  const normalized = normalizeOrigin(value);
  if (!normalized) throw new Error('A valid HTTP or HTTPS Bookarium origin is required.');
  return normalized;
};

export const requestOriginMatches = (supplied, allowedOrigin) => {
  if (typeof supplied !== 'string') return false;
  const normalized = normalizeOrigin(supplied);
  return normalized !== null && supplied === normalized && normalized === allowedOrigin;
};
