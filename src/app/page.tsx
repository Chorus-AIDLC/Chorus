"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { authFetch, resyncRefreshTokenFromStore } from "@/lib/auth-client";

export default function Home() {
  const t = useTranslations();
  const router = useRouter();

  useEffect(() => {
    // Check if user is logged in by checking sessions
    const checkAuth = async () => {
      try {
        // Check admin session
        const adminResponse = await fetch("/api/admin/session");
        const adminData = await adminResponse.json();

        if (adminData.success) {
          router.replace("/admin");
          return;
        }

        // Check user session (works for both OIDC and default auth via cookie).
        // The probe (/api/session) is matcher-covered — the middleware refreshes an
        // expiring cookie on the probe request itself. Retry once for transient
        // refresh failures. Mirrors auth-context.fetchSession's contract.
        let userResponse = await authFetch("/api/session");
        if (userResponse.status === 401) {
          userResponse = await authFetch("/api/session");
        }
        if (userResponse.status === 401) {
          // Last resort (idea 3bf0819c): an iOS cookie purge leaves the middleware
          // nothing to refresh — rebuild refresh materials from the localStorage
          // store, then re-probe once. No-op when nothing is stored.
          if (await resyncRefreshTokenFromStore()) {
            userResponse = await authFetch("/api/session");
          }
        }

        if (userResponse.ok) {
          const userData = await userResponse.json();
          if (userData.success) {
            router.replace("/projects");
            return;
          }
        }

        // Redirect to login ONLY on a true 401 that survived the prime+retry — a
        // genuine "not logged in" signal. A transient/non-401 failure must NOT bounce
        // a still-valid session (e.g. a network blip right after an iOS resume); stay
        // on this lightweight loading screen and let a retry / navigation resolve it.
        if (userResponse.status === 401) {
          router.replace("/login");
        }
      } catch {
        // Network/transient error — do NOT treat as logged-out; do not redirect.
      }
    };

    checkAuth();
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAF8F4]">
      <div className="text-[#737373]">{t("common.loading")}</div>
    </div>
  );
}
