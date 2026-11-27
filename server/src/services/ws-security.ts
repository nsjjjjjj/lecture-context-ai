export function parseAllowedOrigins(value: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const candidate of (value || "").split(",")) {
    try {
      const url = new URL(candidate.trim());
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
      // Invalid allowlist entries never grant access.
    }
  }
  return origins;
}

function normalizedHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function normalizedOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function isAllowedWebSocketOrigin(input: {
  nodeEnv?: string;
  host?: string;
  origin?: string;
  remoteAddress?: string;
  allowedOrigins?: string;
  forwardedProtocol?: string;
}): boolean {
  const host = normalizedHost(input.host);
  const origin = normalizedOrigin(input.origin);
  const allowed = parseAllowedOrigins(input.allowedOrigins);

  if (origin && allowed.has(origin.origin)) return true;
  const forwardedProtocol = input.forwardedProtocol?.split(",")[0]?.trim().toLowerCase();
  const expectedOriginProtocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? `${forwardedProtocol}:`
    : input.nodeEnv === "production"
      ? "https:"
      : "http:";
  if (origin && host && origin.host.toLowerCase() === host && origin.protocol === expectedOriginProtocol) return true;
  if (input.nodeEnv !== "development") return false;

  const remote = input.remoteAddress?.toLowerCase().split("%")[0];
  const localRemote = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!localRemote || !host || !loopback(host.split(":")[0] || "")) return false;
  return !origin || loopback(origin.hostname.toLowerCase());
}

export function positiveEnvironmentInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type FixedWindowRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type FixedWindowRateLimiter = {
  take: (key: string) => FixedWindowRateLimitResult;
};

export function createFixedWindowRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
}): FixedWindowRateLimiter {
  const limit = Math.max(1, Math.floor(options.limit));
  const windowMs = Math.max(1, Math.floor(options.windowMs));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000));
  const now = options.now ?? Date.now;
  const entries = new Map<string, { count: number; resetAt: number }>();

  const makeRoom = (currentTime: number): void => {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= currentTime) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) break;
      entries.delete(oldest);
    }
  };

  return {
    take(key) {
      const currentTime = now();
      const normalizedKey = key.trim() || "unknown";
      let entry = entries.get(normalizedKey);
      if (!entry || entry.resetAt <= currentTime) {
        makeRoom(currentTime);
        entry = { count: 0, resetAt: currentTime + windowMs };
        entries.set(normalizedKey, entry);
      }

      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1_000));
      if (entry.count >= limit) return { allowed: false, retryAfterSeconds };
      entry.count += 1;
      return { allowed: true, retryAfterSeconds };
    }
  };
}

export function resolveClientAddress(input: {
  remoteAddress?: string;
  forwardedFor?: string;
  trustProxy?: boolean;
}): string {
  if (input.trustProxy) {
    const forwarded = input.forwardedFor?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return input.remoteAddress?.trim() || "unknown";
}
