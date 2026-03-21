"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  LayoutDashboard,
  Lightbulb,
  FileText,
  Tags,
  CheckSquare,
  Activity,
  FolderKanban,
  Settings,
  LogOut,
  Menu,
} from "lucide-react";
import { getAccessToken, authFetch, logout as authLogout, clearUserManager } from "@/lib/auth-client";
import { PixelCanvasWidget } from "@/components/pixel-canvas-widget";
import { RealtimeProvider } from "@/contexts/realtime-context";
import { NotificationProvider } from "@/contexts/notification-context";
import { NotificationBell } from "@/components/notification-bell";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { GlobalSearch } from "@/components/global-search";
import { PageTransition } from "@/components/page-transition";
import { motion, AnimatePresence } from "framer-motion";
import { ANIM, dropdownVariants } from "@/lib/animation";

interface User {
  uuid: string;
  email: string;
  name: string;
}

interface Project {
  uuid: string;
  name: string;
}

// Extract project UUID from URL
function extractProjectUuid(pathname: string): string | null {
  // Match /projects/[uuid] or /projects/[uuid]/anything
  const match = pathname.match(/^\/projects\/([a-f0-9-]{36})(\/|$)/);
  return match ? match[1] : null;
}

// Extract project group UUID from URL
function extractGroupUuid(pathname: string): string | null {
  const match = pathname.match(/^\/project-groups\/([a-f0-9-]{36})(\/|$)/);
  return match ? match[1] : null;
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations();
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile drawer on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Get current project UUID from URL (stateful URL)
  const currentProjectUuid = extractProjectUuid(pathname);
  const currentProject = projects.find((p) => p.uuid === currentProjectUuid) || null;

  // Get current group UUID from URL
  const currentGroupUuid = extractGroupUuid(pathname);
  const [currentGroupName, setCurrentGroupName] = useState<string | null>(null);

  useEffect(() => {
    if (!currentGroupUuid) {
      setCurrentGroupName(null);
      return;
    }
    authFetch(`/api/project-groups/${currentGroupUuid}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.success) setCurrentGroupName(data.data.name);
      })
      .catch(() => setCurrentGroupName(null));
  }, [currentGroupUuid]);

  // Global pages: /projects, /projects/new, /settings
  const isGlobalPage =
    pathname === "/projects" ||
    pathname === "/projects/new" ||
    pathname === "/settings" ||
    pathname.startsWith("/project-groups");
  const isProjectContext = currentProjectUuid && !isGlobalPage;

  useEffect(() => {
    checkSession();
    fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkSession = async () => {
    try {
      // Use authFetch which adds OIDC Authorization header if available.
      // For default auth users (no OIDC), cookies are still sent automatically
      // and the server authenticates via the user_session httpOnly cookie.
      let response = await authFetch("/api/auth/session");

      // If access token expired, try refreshing with the refresh token cookie
      if (!response.ok) {
        const refreshRes = await fetch("/api/auth/refresh", { method: "POST" });
        if (refreshRes.ok) {
          // Refresh succeeded — retry session check with new cookies
          response = await authFetch("/api/auth/session");
        }
      }

      if (!response.ok) {
        clearUserManager();
        router.push("/login");
        return;
      }

      const data = await response.json();
      if (data.success && data.data.user) {
        setUser({
          uuid: data.data.user.uuid,
          email: data.data.user.email,
          name: data.data.user.name || data.data.user.email,
        });
      } else {
        clearUserManager();
        router.push("/login");
        return;
      }
    } catch (error) {
      console.error("Session check failed:", error);
      clearUserManager();
      router.push("/login");
      return;
    }

    setLoading(false);
  };

  const fetchProjects = async () => {
    try {
      const response = await authFetch("/api/projects");
      if (!response.ok) {
        console.error("Failed to fetch projects:", response.status);
        return;
      }
      const data = await response.json();
      if (data.success && data.data.length > 0) {
        setProjects(data.data);
      }
    } catch (error) {
      console.error("Failed to fetch projects:", error);
    }
  };

  const selectProject = (project: Project) => {
    setProjectMenuOpen(false);
    // Navigate to project dashboard with UUID in URL
    router.push(`/projects/${project.uuid}/dashboard`);
  };

  const handleLogout = async () => {
    try {
      await authLogout();
    } catch {
      clearUserManager();
    }
    router.push("/login");
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">{t("common.loading")}</div>
      </div>
    );
  }

  // Project navigation items - build URLs using UUIDs
  const getProjectNavItems = (projectUuid: string) => [
    { href: `/projects/${projectUuid}/dashboard`, label: t("nav.overview"), icon: LayoutDashboard },
    { href: `/projects/${projectUuid}/ideas`, label: t("nav.ideas"), icon: Lightbulb },
    { href: `/projects/${projectUuid}/documents`, label: t("nav.documents"), icon: FileText },
    { href: `/projects/${projectUuid}/proposals`, label: t("nav.proposals"), icon: Tags },
    { href: `/projects/${projectUuid}/tasks`, label: t("nav.tasks"), icon: CheckSquare },
    { href: `/projects/${projectUuid}/activity`, label: t("nav.activity"), icon: Activity },
  ];

  // Global navigation items
  const globalNavItems = [
    { href: "/projects", label: t("nav.projects"), icon: FolderKanban },
    { href: "/settings", label: t("nav.settings"), icon: Settings },
  ];

  const isNavActive = (href: string) => {
    // Exact match for dashboard
    if (href.endsWith("/dashboard")) {
      return pathname === href;
    }
    // For /projects list page
    if (href === "/projects") {
      return pathname === "/projects";
    }
    return pathname === href || pathname.startsWith(href + "/");
  };

  // Shared sidebar content used by both desktop aside and mobile Sheet
  const SidebarContent = ({ mobile = false }: { mobile?: boolean }) => {
    // Mobile drawer uses larger text/icons since it has more room (280px vs 220px)
    const navTextSize = mobile ? "text-[15px]" : "text-[13px]";
    const navIconSize = mobile ? "h-5 w-5" : "h-4 w-4";
    const navGap = mobile ? "gap-1.5" : "gap-1";
    const navItemPy = mobile ? "h-10" : "";
    const smallTextSize = mobile ? "text-[13px]" : "text-[11px]";
    const profileNameSize = mobile ? "text-[15px]" : "text-[13px]";
    const profileEmailSize = mobile ? "text-[12px]" : "text-[11px]";

    return (
    <>
      <div className="flex flex-col gap-8 p-6">
        {/* Logo + Notification Bell */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/chorus-icon.png" alt="Chorus" className="h-7 w-7" />
            <span className="text-base font-semibold text-foreground">
              {t("common.appName")}
            </span>
          </div>
          <div className="hidden md:block">
            <NotificationBell />
          </div>
        </div>

        {/* Global Search Trigger — hidden in mobile drawer (already in mobile header) */}
        {!mobile && (
          <GlobalSearch
            currentProjectUuid={currentProjectUuid || undefined}
            currentProjectName={currentProject?.name}
            currentGroupUuid={currentGroupUuid || undefined}
            currentGroupName={currentGroupName || undefined}
          />
        )}

        {/* Navigation */}
        <nav className={`flex flex-col ${navGap}`}>
          {isProjectContext && currentProjectUuid ? (
            <>
              {/* Back to Projects */}
              <Link href="/projects">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground ${navTextSize} ${navItemPy}`}
                >
                  <ArrowLeft className={mobile ? "h-4 w-4" : "h-3 w-3"} />
                  {t("nav.backToProjects")}
                </Button>
              </Link>

              {/* Current Project Selector */}
              {currentProject && (
                <div className="relative mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setProjectMenuOpen(!projectMenuOpen)}
                    className="w-full justify-between px-3 py-1.5"
                  >
                    <span className={`truncate font-semibold uppercase tracking-wider text-foreground ${smallTextSize}`}>
                      {currentProject.name}
                    </span>
                    <ChevronDown
                      className={`h-3 w-3 text-muted-foreground transition-transform ${projectMenuOpen ? "rotate-180" : ""}`}
                    />
                  </Button>
                  <AnimatePresence>
                    {projectMenuOpen && (
                      <motion.div
                        variants={dropdownVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="absolute left-0 right-0 top-full z-10 mt-1 origin-top rounded-lg border border-border bg-card py-1 shadow-lg"
                      >
                        {projects.map((project) => (
                          <Button
                            key={project.uuid}
                            variant="ghost"
                            size="sm"
                            onClick={() => selectProject(project)}
                            className={`w-full justify-start px-3 py-2 ${navTextSize} [&>*]:truncate ${
                              currentProject?.uuid === project.uuid
                                ? "bg-secondary font-medium text-foreground"
                                : "text-muted-foreground"
                            }`}
                          >
                            <span className="truncate">{project.name}</span>
                          </Button>
                        ))}
                        <div className="my-1 border-t border-border" />
                        <Link
                          href="/projects/new"
                          onClick={() => setProjectMenuOpen(false)}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            className={`w-full justify-start gap-2 px-3 py-2 ${navTextSize} text-primary`}
                          >
                            <Plus className="h-3 w-3" />
                            {t("nav.newProject")}
                          </Button>
                        </Link>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Project Navigation Items */}
              <div className={`mt-2 flex flex-col ${navGap}`}>
                {getProjectNavItems(currentProjectUuid).map((item) => {
                  const isActive = isNavActive(item.href);
                  const Icon = item.icon;
                  return (
                    <Link key={item.href} href={item.href}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`relative w-full justify-start gap-2.5 ${navTextSize} ${navItemPy} ${
                          isActive
                            ? "font-medium text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {isActive && (
                          <motion.div
                            layoutId="nav-active"
                            className="absolute inset-0 rounded-md bg-secondary"
                            transition={{ type: "spring", stiffness: 500, damping: 30 }}
                          />
                        )}
                        <span className="relative flex items-center gap-2.5">
                          <Icon
                            className={`${navIconSize} ${isActive ? "text-primary" : ""}`}
                          />
                          {item.label}
                        </span>
                      </Button>
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {/* Global Navigation Items */}
              <div className={`flex flex-col ${navGap}`}>
                {globalNavItems.map((item) => {
                  const isActive = isNavActive(item.href);
                  const Icon = item.icon;
                  return (
                    <Link key={item.href} href={item.href}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`relative w-full justify-start gap-2.5 ${navTextSize} ${navItemPy} ${
                          isActive
                            ? "font-medium text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {isActive && (
                          <motion.div
                            layoutId="nav-active"
                            className="absolute inset-0 rounded-md bg-secondary"
                            transition={{ type: "spring", stiffness: 500, damping: 30 }}
                          />
                        )}
                        <span className="relative flex items-center gap-2.5">
                          <Icon className={`${navIconSize} ${isActive ? "text-primary" : ""}`} />
                          {item.label}
                        </span>
                      </Button>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </nav>
      </div>

      {/* User Profile */}
      <div className="p-6">
        <div className="flex items-center gap-2">
          <div className={`flex items-center justify-center rounded-full bg-primary font-medium text-primary-foreground ${mobile ? "h-10 w-10 text-base" : "h-9 w-9 text-sm"}`}>
            {user?.name?.charAt(0) || "U"}
          </div>
          <div className="min-w-0 flex-1">
            <div className={`truncate font-medium text-foreground ${profileNameSize}`}>
              {user?.name}
            </div>
            <div className={`truncate text-muted-foreground ${profileEmailSize}`}>
              {user?.email}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleLogout}
            title={t("common.signOut")}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
    );
  };

  return (
    <NotificationProvider>
    <div className="flex min-h-screen bg-background">
      {/* Mobile Header - visible below md */}
      <header className="fixed top-0 left-0 right-0 z-30 border-b border-border bg-card md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <button onClick={() => setMobileMenuOpen(true)} aria-label={t("nav.openMenu")}>
            <Menu className="h-5 w-5 text-muted-foreground" />
          </button>
          <div className="flex items-center gap-2">
            <img src="/chorus-icon.png" alt="Chorus" className="h-6 w-6" />
            <span className="text-sm font-semibold text-foreground">{t("common.appName")}</span>
          </div>
          <div className="flex items-center gap-2">
            <GlobalSearch
              currentProjectUuid={currentProjectUuid || undefined}
              currentProjectName={currentProject?.name}
              currentGroupUuid={currentGroupUuid || undefined}
              currentGroupName={currentGroupName || undefined}
            />
            <NotificationBell />
          </div>
        </div>
      </header>

      {/* Mobile Drawer */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="w-[280px] p-0">
          <div className="flex h-full flex-col justify-between overflow-y-auto">
            <SidebarContent mobile />
          </div>
        </SheetContent>
      </Sheet>

      {/* Desktop Sidebar - hidden below md */}
      <aside className="hidden md:sticky md:top-0 md:flex h-screen w-[220px] flex-shrink-0 flex-col justify-between overflow-y-auto border-r border-border bg-card">
        <SidebarContent />
      </aside>

      {/* Main Content - add top padding on mobile for the fixed header (now ~110px with search) */}
      {isProjectContext && currentProject ? (
        <RealtimeProvider projectUuid={currentProject.uuid}>
          <main className="flex-1 flex flex-col overflow-auto pt-14 md:pt-0"><PageTransition>{children}</PageTransition></main>
          <PixelCanvasWidget
            projectUuid={currentProject.uuid}
            projectName={currentProject.name}
          />
        </RealtimeProvider>
      ) : (
        <main className="flex-1 flex flex-col overflow-auto pt-14 md:pt-0"><PageTransition>{children}</PageTransition></main>
      )}
    </div>
    </NotificationProvider>
  );
}
