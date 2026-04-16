"use client";

import {
  createContext,
  useContext,
  useEffect,
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

  // Fetch current session from backend
  const fetchSession = useCallback(async () => {
    try {
      const response = await authFetch("/api/auth/session");
      const data = await response.json();

      if (data.success) {
        setUser(data.data.user);
        setCompany(data.data.company);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  // Initialize session on mount
  useEffect(() => {
    const init = async () => {
      setLoading(true);

      // Check if we have an OIDC user
      const oidcUser = await getOidcUser();

      if (oidcUser && !oidcUser.expired) {
        // Sync token (and refresh token) to cookie in case it was refreshed while the page was away
        await syncTokenToCookie(oidcUser.access_token, oidcUser.refresh_token);
        // We have a valid OIDC session, fetch user info from backend
        await fetchSession();
      }

      setLoading(false);
    };

    init();
  }, [fetchSession]);

  // Set up OIDC event handlers
  useEffect(() => {
    const manager = getUserManager();
    if (!manager) return;

    // Handle token expiring (oidc-client-ts will auto-renew)
    const handleExpiring = () => {
      clientLogger.debug("OIDC token expiring, will be auto-renewed");
    };

    // Handle token expired
    const handleExpired = () => {
      clientLogger.debug("OIDC token expired");
      handleSessionExpired();
    };

    // Handle silent renew error
    const handleRenewError = (err: Error) => {
      clientLogger.error("Silent renew error:", err);
      handleSessionExpired();
    };

    // Handle user loaded (after silent renew) — sync new token + refresh token to cookie
    const handleUserLoaded = async (user: User) => {
      clientLogger.debug("OIDC user loaded/renewed, syncing token to cookie");
      try {
        await syncTokenToCookie(user.access_token, user.refresh_token);
      } catch (err) {
        clientLogger.error("Failed to sync token after renewal:", err);
      }
    };

    manager.events.addAccessTokenExpiring(handleExpiring);
    manager.events.addAccessTokenExpired(handleExpired);
    manager.events.addSilentRenewError(handleRenewError);
    manager.events.addUserLoaded(handleUserLoaded);

    return () => {
      manager.events.removeAccessTokenExpiring(handleExpiring);
      manager.events.removeAccessTokenExpired(handleExpired);
      manager.events.removeSilentRenewError(handleRenewError);
      manager.events.removeUserLoaded(handleUserLoaded);
    };
  }, []);

  // Handle session expired
  const handleSessionExpired = () => {
    setUser(null);
    setCompany(null);
    setError("Session expired. Please log in again.");
    router.push("/login");
  };

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
