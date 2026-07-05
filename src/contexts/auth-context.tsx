"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  authFetch,
  resyncRefreshTokenFromStore,
  purgeDeadSession,
  logout as authLogout,
  clearUserManager,
} from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";

// User info from OIDC
interface UserInfo {
  uuid: string;
  email: string;
  name?: string;
}

// Company info from session
interface CompanyInfo {
  uuid: string;
  name: string;
}

// Auth context state
interface AuthContextState {
  user: UserInfo | null;
  company: CompanyInfo | null;
  loading: boolean;
  error: string | null;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Handle a genuinely dead session: clear state and route to login.
  // Defined before fetchSession so the 401 path below can call it.
  const handleSessionExpired = useCallback(() => {
    setUser(null);
    setCompany(null);
    setError("Session expired. Please log in again.");
    // The verdict's recovery attempt has already proven the stored refresh token dead —
    // purge the localStorage copy so future /login visits don't re-attempt a doomed
    // recovery (fire-and-forget; the redirect must not wait on it).
    void purgeDeadSession();
    router.push("/login");
  }, [router]);

  // Fetch current session from backend.
  //
  // The probe (`/api/session`) is matcher-covered, so the middleware refreshes an
  // expiring/expired access cookie on the probe request itself — no separate priming
  // request is needed. A single 401 still does NOT mean the session is dead: the
  // middleware is lenient about transient refresh failures (IdP hiccup, iOS radio not
  // up yet), so we retry ONCE (a second refresh chance), then attempt the localStorage
  // refresh-token recovery (iOS cookie purge), and only a 401 that survives all of it
  // is a true re-login condition. A transient/network failure must NOT redirect (the
  // next request retries), so it leaves session state untouched.
  const fetchSession = useCallback(async () => {
    try {
      let response = await authFetch("/api/session");

      if (response.status === 401) {
        // Retry once — a second middleware refresh chance for transient failures.
        response = await authFetch("/api/session");
        if (response.status === 401) {
          // Last resort before declaring death (idea 3bf0819c): the double-401 may be
          // an iOS cookie purge whose early resync (init/revalidate) lost a race —
          // e.g. the radio wasn't up at resume instant, or a parallel prober reached
          // this verdict before the recovery chain finished. Rebuild the refresh
          // materials from the localStorage store and give the middleware ONE more
          // chance. The helper no-ops (false) without a stored refresh token, and a
          // genuinely dead RT fails the IdP exchange during the prime — so true
          // session death still lands in handleSessionExpired right below.
          if (await resyncRefreshTokenFromStore()) {
            response = await authFetch("/api/session");
          }
        }
        if (response.status === 401) {
          // Genuine session death (survived middleware refresh AND recovery).
          handleSessionExpired();
          return false;
        }
      }

      const data = await response.json();

      if (data.success) {
        setUser(data.data.user);
        setCompany(data.data.company);
        return true;
      }
      return false;
    } catch {
      // Network/transient error — do not treat as session death, do not redirect.
      return false;
    }
  }, [handleSessionExpired]);

  // Initialize session on mount: a single probe. The probe request is
  // matcher-covered (the middleware refreshes an expiring cookie on it), and
  // fetchSession's verdict chain owns retry + iOS cookie-purge recovery — there is
  // no separate init-time sync/recovery step. Cookie-based, so this populates
  // `user` for every login mode (OIDC, default-auth, superadmin).
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await fetchSession();
      setLoading(false);
    };

    init();
  }, [fetchSession]);

  // Re-validate the session when the page is RESTORED after being backgrounded.
  //
  // This is the fix for the iOS Chrome (WebKit) report: long-backgrounded tabs are
  // restored from bfcache / frozen state via `pageshow(persisted)` or a
  // visibilitychange→visible with NO server document request. In that case the access
  // cookie may have expired in the background and nothing has refreshed it. We prime the
  // cookie (matcher-covered request → middleware refresh) and re-resolve the session, so a
  // resumed tab with a still-valid refresh token stays logged in instead of bouncing.
  // `fetchSession` itself only redirects after its full verdict chain (retry +
  // recovery) fails, so a truly dead session still goes to /login cleanly.
  //
  // A ref holds the latest fetchSession so this effect can mount once (empty deps) without
  // re-binding listeners on every fetchSession identity change.
  const fetchSessionRef = useRef(fetchSession);
  fetchSessionRef.current = fetchSession;
  const revalidateInFlight = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;

    // An in-flight guard collapses the burst of resume signals into a single
    // prime+probe cycle: an iOS bfcache restore fires BOTH `pageshow(persisted)` and
    // `visibilitychange→visible`, and a refocus can fire visibilitychange repeatedly.
    // Without the guard each would kick its own prime + 1-2 probes. It is idempotent
    // either way (no redirect storm), but the guard avoids the redundant traffic.
    const revalidate = async () => {
      if (revalidateInFlight.current) return;
      revalidateInFlight.current = true;
      // Recovery (iOS cookie purge) lives inside fetchSession's verdict chain — the
      // resume path needs no separate recovery step. Concurrent resume requests from
      // SSE contexts are harmless: rotation is off, so parallel middleware refreshes
      // of the same refresh token all succeed (re-enabling rotation at the IdP would
      // require reintroducing resume burst suppression — see the oidc-session-refresh
      // spec).
      try {
        await fetchSessionRef.current();
      } finally {
        revalidateInFlight.current = false;
      }
    };

    const onPageShow = (e: PageTransitionEvent) => {
      // Only react to bfcache restores; a normal load already ran the init effect.
      if (e.persisted) revalidate();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate();
    };

    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Logout
  const logout = async () => {
    try {
      // Clear backend session
      await fetch("/api/session", { method: "DELETE" });

      // OIDC logout
      await authLogout();

      setUser(null);
      setCompany(null);
      router.push("/login");
    } catch (err) {
      clientLogger.error("Logout error:", err);
      // Clear state and redirect even on error
      clearUserManager();
      router.push("/login");
    }
  };

  // Manual session refresh
  const refreshSession = async () => {
    await fetchSession();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        company,
        loading,
        error,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// Hook to use auth context
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

// Hook to require authentication
export function useRequireAuth() {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!auth.loading && !auth.user) {
      router.push("/login");
    }
  }, [auth.loading, auth.user, router]);

  return auth;
}
