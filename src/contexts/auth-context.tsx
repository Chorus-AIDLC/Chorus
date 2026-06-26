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
import { User } from "oidc-client-ts";
import {
  getUserManager,
  getOidcUser,
  authFetch,
  syncTokenToCookie,
  primeSessionCookie,
  logout as authLogout,
  clearUserManager,
} from "@/lib/auth-client";
import { computeKeepaliveDelayMs, pingKeepalive } from "@/lib/oidc-keepalive";
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
    router.push("/login");
  }, [router]);

  // Fetch current session from backend.
  //
  // The session probe (`/api/auth/session`) is NOT matcher-covered, so it can't refresh
  // the cookie itself. A 401 therefore does NOT immediately mean the session is dead — it
  // may just mean the access cookie expired while the page was backgrounded and no
  // middleware-covered request has run yet (the iOS bfcache/resume case). So on a 401 we
  // first `primeSessionCookie()` (a matcher-covered request that lets the middleware refresh
  // the cookie from the refresh token) and retry the probe ONCE. Only if the retry is still
  // 401 is the refresh token genuinely expired/revoked — a true re-login condition. A
  // transient/network failure must NOT redirect (the next request retries), so it leaves
  // session state untouched.
  const fetchSession = useCallback(async () => {
    try {
      let response = await authFetch("/api/auth/session");

      if (response.status === 401) {
        // Give the middleware a chance to refresh the cookie, then retry once.
        await primeSessionCookie();
        response = await authFetch("/api/auth/session");
        if (response.status === 401) {
          // Genuine session death (survived a middleware refresh attempt).
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

  // Initialize session on mount
  useEffect(() => {
    const init = async () => {
      setLoading(true);

      // If we have a valid OIDC user, sync its (possibly refreshed) token to the
      // cookie first so the backend session lookup sees the freshest token.
      const oidcUser = await getOidcUser();
      if (oidcUser && !oidcUser.expired) {
        await syncTokenToCookie(oidcUser.access_token, oidcUser.refresh_token);
      } else {
        // No fresh OIDC user in localStorage (e.g. the page was restored from bfcache /
        // a frozen tab and the access cookie may have expired in the background). Prime
        // the cookie via a matcher-covered request so the middleware refreshes it from the
        // refresh token BEFORE the (non-matcher-covered) session probe below. Without this,
        // the probe would 401 and bounce the user even though the refresh token is valid.
        await primeSessionCookie();
      }

      // Always resolve the session from the backend. `/api/auth/session` accepts
      // BOTH an OIDC bearer token AND a session cookie (default-auth / superadmin
      // set `user_session` / `admin_session` with no OIDC user), so this populates
      // `user` for every login mode — not just OIDC. Previously this was gated
      // behind the OIDC branch, leaving `user` permanently null for default-auth
      // users and silently disabling every owner-gated UI (e.g. the comment
      // mention badge's owner-only "Open conversation" button).
      await fetchSession();

      setLoading(false);
    };

    init();
  }, [fetchSession]);

  // Set up OIDC event handlers.
  //
  // We deliberately do NOT redirect to /login on `addAccessTokenExpired` or
  // `addSilentRenewError`. An expired access token is not a dead session: the Edge
  // middleware silently refreshes the cookie on the next request, and getAuthContext
  // falls through to it. Treating expiry as logout (the previous behavior) bounced
  // users out while their cookie session was still valid. Session death is decided
  // only by a true 401 from /api/auth/session (see fetchSession). The only handler we
  // keep is `addUserLoaded`, which syncs the token oidc-client-ts already holds into
  // the cookie at initial login — it does not consume the refresh token.
  useEffect(() => {
    const manager = getUserManager();
    if (!manager) return;

    const handleUserLoaded = async (user: User) => {
      clientLogger.debug("OIDC user loaded, syncing token to cookie");
      try {
        await syncTokenToCookie(user.access_token, user.refresh_token);
      } catch (err) {
        clientLogger.error("Failed to sync token after load:", err);
      }
    };

    manager.events.addUserLoaded(handleUserLoaded);

    return () => {
      manager.events.removeUserLoaded(handleUserLoaded);
    };
  }, []);

  // OIDC keepalive (DEFENSE-IN-DEPTH — not a correctness dependency).
  //
  // The middleware refreshes the cookie on any matcher-covered request, but a user idle
  // on a single SPA page may make none for a while, letting the cookie lapse mid-idle.
  // When (and only when) there is an OIDC session, schedule a ping to a middleware-covered
  // path shortly before the access token expires so the middleware rotates the cookie. The
  // interval is derived from the token's own exp/iat (not a fixed constant). If this whole
  // block were removed, sessions would still be correct — the next real request is rescued
  // by the middleware fall-through; this only shrinks the idle SSE-drop window.
  const keepaliveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // No OIDC manager ⇒ default-auth/superadmin (or logged out) ⇒ do not arm. (Harmless if
    // it ever did: the keepalive path is a no-op for a non-OIDC session.)
    const manager = getUserManager();
    if (!manager) return;

    let cancelled = false;

    const schedule = async () => {
      if (cancelled) return;
      const oidcUser = await getOidcUser();
      // Only arm while an OIDC session exists.
      if (cancelled || !oidcUser) return;

      const delay = computeKeepaliveDelayMs(oidcUser.access_token, Date.now());
      keepaliveTimer.current = setTimeout(async () => {
        if (cancelled) return;
        await pingKeepalive(); // best-effort; middleware refreshes the cookie
        schedule(); // re-arm from the (current) token's exp
      }, delay);
    };

    schedule();

    return () => {
      cancelled = true;
      if (keepaliveTimer.current) {
        clearTimeout(keepaliveTimer.current);
        keepaliveTimer.current = null;
      }
    };
  }, []);

  // Re-validate the session when the page is RESTORED after being backgrounded.
  //
  // This is the fix for the iOS Chrome (WebKit) report: long-backgrounded tabs are
  // restored from bfcache / frozen state via `pageshow(persisted)` or a
  // visibilitychange→visible with NO server document request. In that case the access
  // cookie may have expired in the background and nothing has refreshed it. We prime the
  // cookie (matcher-covered request → middleware refresh) and re-resolve the session, so a
  // resumed tab with a still-valid refresh token stays logged in instead of bouncing.
  // `fetchSession` itself only redirects on a genuine post-prime 401, so a truly dead
  // session still goes to /login cleanly.
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
      try {
        await primeSessionCookie();
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
      await fetch("/api/auth/session", { method: "DELETE" });

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
