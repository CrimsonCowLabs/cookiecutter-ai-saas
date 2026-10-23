import { isIP } from "node:net";
import { getRedis } from "@/lib/redis";

interface RateLimitResult {
  success: boolean;
  remaining: number;
  reset: number; // seconds until window resets
}

/**
 * The bucket a per-client rate limit counts this request in: the first
 * X-Forwarded-For entry, which Caddy sets to the connecting address.
 *
 * An IPv6 client counts by its /64, as Caddy's own limits do (ipv6_prefix 64
 * in the Caddyfile): one subscriber is handed a whole /64 and can send each
 * request from a fresh address in it. An IPv4-mapped address (::ffff:1.2.3.4)
 * counts as the IPv4 address it carries, since every one of them sits in the
 * same /64.
 *
 * With no address, every request shares the "unknown" bucket. That is
 * harmless behind Caddy, which overwrites X-Forwarded-For with the connecting
 * address, but without a proxy all header-less clients share one limit.
 */
export function clientKey(headers: Headers): string {
  const ip = headers.get("x-forwarded-for")?.split(",")[0].trim();
  if (!ip) return "unknown";
  if (isIP(ip) !== 6) return ip;
  const groups = ipv6Groups(ip);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of `ip`, a valid IPv6 address. */
function ipv6Groups(ip: string): number[] {
  const parse = (part: string | undefined) =>
    (part ? part.split(":") : []).flatMap((g) => {
      if (!g.includes(".")) return [parseInt(g, 16)];
      const [a, b, c, d] = g.split(".").map(Number);
      return [(a << 8) | b, (c << 8) | d];
    });
  // "::" stands for as many zero groups as the address leaves out. A zone
  // (fe80::1%eth0) is not part of the address.
  const [head, tail] = ip.split("%")[0].split("::");
  const left = parse(head);
  const right = parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Sliding window rate limiter using Redis INCR + EXPIRE.
 * @param key - Unique key for this rate limit (e.g., "job:userId")
 * @param limit - Max requests allowed in the window
 * @param windowSec - Window duration in seconds
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const redis = getRedis();
  const fullKey = `rl:${key}`;

  const multi = redis.multi();
  multi.incr(fullKey);
  multi.ttl(fullKey);
  const results = await multi.exec();

  const count = (results?.[0]?.[1] as number) ?? 1;
  const ttl = (results?.[1]?.[1] as number) ?? -1;

  // Set expiry on first request in window
  if (ttl === -1) {
    await redis.expire(fullKey, windowSec);
  }

  return {
    success: count <= limit,
    remaining: Math.max(0, limit - count),
    reset: ttl === -1 ? windowSec : ttl,
  };
}

/**
 * Helper to check rate limit and return a 429 Response if exceeded.
 * For use in API routes.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<Response | null> {
  const result = await rateLimit(key, limit, windowSec);
  if (!result.success) {
    return new Response(
      JSON.stringify({
        error: "Too many requests. Please try again later.",
        retryAfter: result.reset,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(result.reset),
        },
      }
    );
  }
  return null;
}

/**
 * Helper for server actions — throws if rate limited.
 */
export async function enforceRateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<void> {
  const result = await rateLimit(key, limit, windowSec);
  if (!result.success) {
    throw new Error("Too many requests. Please try again later.");
  }
}
