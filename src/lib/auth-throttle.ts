import { createHash } from "crypto";
import { isIP } from "net";
import { NextRequest, NextResponse } from "next/server";

// Process-local fallback: use a shared edge limiter for distributed or sustained
// attacks. Trust XFF only behind an enforced proxy chain with no direct bypass.
// Keys contain hashes, not credentials; unavailable addresses have no shared bucket.
const WINDOW_MS = 60_000;
const CAPACITY = 10_000;
const buckets = new Map<string, { count: number; expiresAt: number }>();
const limits = { identify: 30, login: 10, accept: 10 } as const;
let nextSweepAt = 0;

function trustedAddress(request: NextRequest): string | null {
  if (process.env.AUTH_TRUST_PROXY !== "true") return null;
  const hops = Number(process.env.AUTH_TRUST_PROXY_HOPS ?? "1");
  if (!Number.isInteger(hops) || hops < 1 || hops > 16) return null;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",");
  if (!forwarded || forwarded.length < hops) return null;
  const value = forwarded[forwarded.length - hops].trim();
  // ALB can optionally append a client port, including bracketed IPv6.
  const address = value.match(/^\[([^\]]+)\]:\d+$/)?.[1]
    ?? value.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)?.[1]
    ?? value;
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6 && !address.includes("%")) return new URL(`http://[${address}]`).hostname.slice(1, -1);
  return null;
}

export function throttleAuth(request: NextRequest, action: keyof typeof limits, supplemental = ""): NextResponse | null {
  const now = Date.now();
  if (now >= nextSweepAt) {
    for (const [key, value] of buckets) if (value.expiresAt <= now) buckets.delete(key);
    nextSweepAt = now + WINDOW_MS;
  }
  const address = trustedAddress(request);
  const identity = createHash("sha256").update(supplemental).digest("hex");
  // A known client cannot evade its address limit by rotating identifiers. With
  // no trusted address, only the requested identity/token is limited, not all users.
  const keys = [`${action}:identity:${address ?? ""}:${identity}`];
  if (address) keys.push(`${action}:address:${address}`);
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (bucket && bucket.expiresAt <= now) buckets.delete(key);
    else if (bucket && bucket.count >= limits[action]) {
      buckets.delete(key); buckets.set(key, bucket);
      return NextResponse.json({ success: false, error: { code: "RATE_LIMITED", message: "Too many authentication attempts. Please try again shortly." } }, { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))) } });
    }
  }
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (bucket) { bucket.count++; buckets.delete(key); buckets.set(key, bucket); }
    else {
      // Bound memory without making full capacity a global authentication outage.
      // Eviction makes this best-effort under pressure; the edge limiter is required.
      if (buckets.size >= CAPACITY) buckets.delete(buckets.keys().next().value!);
      buckets.set(key, { count: 1, expiresAt: now + WINDOW_MS });
    }
  }
  return null;
}

export function resetAuthThrottleForTests(): void { buckets.clear(); nextSweepAt = 0; }
