"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  ChevronDown,
  LayoutDashboard,
  FileText,
  Tags,
  CheckSquare,
  Activity,
  FolderKanban,
  Settings,
  LogOut,
  Menu,
  Network,
} from "lucide-react";
import { authFetch, logout as authLogout, clearUserManager } from "@/lib/auth-client";
import { PixelCanvasWidget } from "@/components/pixel-canvas-widget";
import { RealtimeProvider } from "@/contexts/realtime-context";
import { AgentPresenceProvider } from "@/contexts/agent-presence-context";
import { PixelActivityProvider } from "@/contexts/pixel-activity-context";
import { AuthProvider } from "@/contexts/auth-context";
import { DaemonPresenceEntry } from "@/components/daemon-presence-entry";
import { SidebarPreferences } from "@/components/sidebar-preferences";
import { AgentConnectionsModal } from "@/components/agent-presence";
import { NotificationProvider } from "@/contexts/notification-context";
import { NotificationBell } from "@/components/notification-bell";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { GlobalSearch } from "@/components/global-search";
import { PageTransition } from "@/components/page-transition";
import { Toaster } from "@/components/ui/sonner";
import { motion, AnimatePresence } from "framer-motion";
import { dropdownVariants } from "@/lib/animation";
import { clientLogger } from "@/lib/logger-client";

interface User {
  uuid: string;
  email: string;
  name: string;
}

interface Project {
  uuid: string;
  name: string;
}

interface CurrentProject extends Project {
  groupUuid: string | null;
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
  const [currentProject, setCurrentProject] = useState<CurrentProject | null>(null);
  const [siblingProjects, setSiblingProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Close mobile drawer on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Get current project UUID from URL (stateful URL)
  const currentProjectUuid = extractProjectUuid(pathname);

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

  // Global pages: /projects, /settings
  const isGlobalPage =
    pathname === "/projects" ||
    pathname === "/settings" ||
    pathname.startsWith("/project-groups");
  const isProjectContext = currentProjectUuid && !isGlobalPage;
  // Pages that opt out of the centered max-w-[1200px] container and use the
  // full main width — they have wide horizontal content (the task kanban
  // board, the resource graph mind-map).
  const isFullWidthPage = pathname.match(
    /^\/projects\/[a-f0-9-]{36}\/(tasks|graph)(\/|$)/,
  );

  useEffect(() => { checkSession(); }, []);

  // Fetch current project + sibling projects when URL changes
  useEffect(() => {
    if (!currentProjectUuid || isGlobalPage) {
      setCurrentProject(null);
      setSiblingProjects([]);
      return;
    }

    let cancelled = false;

    async function fetchCurrentProject() {
      try {
        const res = await authFetch(`/api/projects/${currentProjectUuid}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!data.success || cancelled) return;
        const proj: CurrentProject = {
          uuid: data.data.uuid,
          name: data.data.name,
          groupUuid: data.data.groupUuid ?? null,
        };
        setCurrentProject(proj);

        // Fetch sibling projects from the same group
        if (proj.groupUuid) {
          const groupRes = await authFetch(`/api/project-groups/${proj.groupUuid}`);
          if (!groupRes.ok || cancelled) return;
          const groupData = await groupRes.json();
          if (groupData.success && !cancelled) {
            setSiblingProjects(
              (groupData.data.projects || []).filter(
                (p: Project) => p.uuid !== currentProjectUuid
              )
            );
          }
        } else {
          setSiblingProjects([]);
        }
      } catch (error) {
        clientLogger.error("Failed to fetch current project:", error);
      }
    }

    fetchCurrentProject();
    return () => { cancelled = true; };
  }, [currentProjectUuid, isGlobalPage]);

  const checkSession = async () => {
    try {
      // Cookie-based probe (all login modes). /api/session is matcher-covered, so
      // the middleware refreshes an expiring cookie on this very request; retry once
      // for transient failures.
      let response = await authFetch("/api/session");
      if (response.status === 401) {
        response = await authFetch("/api/session");
      }

      // Session death is decided ONLY by AuthProvider's fetchSession (mounted in this
      // same tree) — it holds the full verdict chain including the last-resort
      // localStorage refresh-token recovery. This probe must NOT issue its own
      // /login redirect: a second independent death-decider can win the race against
      // the recovery chain and bounce a recoverable session (the 2026-07-05 04:37Z
      // recurrence). On a persistent 401 here, just stop the loading gate; if the
      // session is truly dead, AuthProvider redirects moments later.
      if (response.status === 401) {
        setLoading(false);
        return;
      }

      if (!response.ok) {
        // Transient/non-401 error — do not redirect; stop the loading gate and retry later.
        setLoading(false);
        return;
      }

      const data = await response.json();
      if (data.success && data.data.user) {
        setUser({
          uuid: data.data.user.uuid,
          email: data.data.user.email,
          name: data.data.user.name || data.data.user.email,
        });
      }
      // A non-success body without a 401 is treated as transient: don't bounce, just
      // leave session state and let a later check resolve it.
    } catch (error) {
      // Network/transient error — do NOT treat as session death, do not redirect.
      clientLogger.error("Session check failed:", error);
    }

    setLoading(false);
  };

  const selectProject = (project: Project) => {
    setProjectMenuOpen(false);
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
    // Ideas list page removed — idea browsing lives in the Dashboard (Overview).
    // The /ideas RESTful URLs are 308-redirected to the Dashboard in middleware.
    { href: `/projects/${projectUuid}/documents`, label: t("nav.documents"), icon: FileText },
    { href: `/projects/${projectUuid}/proposals`, label: t("nav.proposals"), icon: Tags },
    { href: `/projects/${projectUuid}/tasks`, label: t("nav.tasks"), icon: CheckSquare },
    { href: `/projects/${projectUuid}/graph`, label: t("nav.graph"), icon: Network },
    { href: `/projects/${projectUuid}/activity`, label: t("nav.activity"), icon: Activity },
  ];

  // Global navigation items.
  // Note: the former /agent-connections page + its RadioTower nav item were
  // removed — that view now lives in the daemon chat modal opened from the
  // bottom-right daemon-presence entry (the former path is redirected to the
  // dashboard in middleware). See AgentConnectionsModal + DaemonPresenceEntry
  // mounted in the shell below.
  // Settings is NOT here — it moved to the resident footer (below), so it shows
  // on every dashboard page (project + global), not just the global-nav branch.
  const globalNavItems = [
    { href: "/projects", label: t("nav.projects"), icon: FolderKanban },
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
                    onClick={() => siblingProjects.length > 0 && setProjectMenuOpen(!projectMenuOpen)}
                    className={`w-full justify-between px-3 py-1.5 ${siblingProjects.length === 0 ? "cursor-default" : ""}`}
                  >
                    <span className={`truncate font-semibold uppercase tracking-wider text-foreground ${smallTextSize}`}>
                      {currentProject.name}
                    </span>
                    {siblingProjects.length > 0 && (
                      <ChevronDown
                        className={`h-3 w-3 text-muted-foreground transition-transform ${projectMenuOpen ? "rotate-180" : ""}`}
                      />
                    )}
                  </Button>
                  <AnimatePresence>
                    {projectMenuOpen && siblingProjects.length > 0 && (
                      <motion.div
                        variants={dropdownVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="absolute left-0 right-0 top-full z-10 mt-1 origin-top rounded-lg border border-border bg-card py-1 shadow-lg"
                      >
                        {siblingProjects.map((project) => (
                          <Button
                            key={project.uuid}
                            variant="ghost"
                            size="sm"
                            onClick={() => selectProject(project)}
                            className={`w-full justify-start px-3 py-2 ${navTextSize} [&>*]:truncate text-muted-foreground`}
                          >
                            <span className="truncate">{project.name}</span>
                          </Button>
                        ))}
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

      {/* Bottom-pinned rail footer: Settings + appearance/language utility row
          above the user-profile block. Grouped into ONE flex child so the rail's
          justify-between pins the whole footer to the bottom-left. The former
          agent-presence pill was removed here — daemon presence now lives in the
          single bottom-right floating DaemonPresenceEntry (mounted at the shell);
          Settings moved INTO this footer (from the global nav) so it is reachable
          from every page without backing out to the projects list first. */}
      <div className="mt-auto flex flex-col gap-1 px-4 pb-4">
        {/* Settings — resident footer entry, present on EVERY dashboard page
            (project + global), so a user deep in a project can reach it without
            navigating back out. Active-state styling mirrors the nav items. */}
        <Link href="/settings">
          <Button
            variant="ghost"
            size="sm"
            className={`relative w-full justify-start gap-2.5 ${navTextSize} ${navItemPy} ${
              isNavActive("/settings")
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isNavActive("/settings") && (
              <motion.div
                layoutId="nav-active"
                className="absolute inset-0 rounded-md bg-secondary"
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            )}
            <span className="relative flex items-center gap-2.5">
              <Settings className={`${navIconSize} ${isNavActive("/settings") ? "text-primary" : ""}`} />
              {t("nav.settings")}
            </span>
          </Button>
        </Link>

        {/* Appearance + language — a quiet paired utility row. Compact
            icon-triggers (theme glyph + locale code) so preferences read as
            low-key, not primary nav. Rendered in both the desktop aside and the
            mobile Sheet (both render SidebarContent). */}
        <SidebarPreferences mobile={mobile} />

        {/* User Profile */}
        <div className="px-2 pt-1">
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
      </div>
    </>
    );
  };

  return (
    <NotificationProvider>
    {/* AuthProvider exposes the current user via useAuth() to the whole shell.
        It is mounted here (not the root layout) because only the authenticated
        dashboard tree needs it: the comment mention badge's owner gate reads
        useAuth().user.uuid. AuthProvider self-fetches /api/session (the same
        endpoint this layout already polls), so it is additive — the layout keeps
        its own local `user` state for the sidebar; this provider serves consumers
        deep in the tree that can't be prop-threaded (e.g. MentionBadge inside a
        rendered comment body). Without it, useAuth() throws and any agent mention
        in a comment crashes the comment area. */}
    <AuthProvider>
    {/* AgentPresenceProvider is the single shell-level data spine for the
        bottom-right daemon-presence entry + its roster popover + the chat modal.
        Mounted ONCE here, wrapping the whole shell (sidebar + main), so it
        survives route changes (does not remount per navigation) and is
        independent of the per-route, project-scoped RealtimeProvider branches
        below. */}
    <AgentPresenceProvider>
    {/* PixelActivityProvider — the shell↔project bridge that lets the shell-level
        DaemonPresenceEntry open the project-scoped pixel-canvas activity view.
        Wraps both the entry (reads `available` + toggles `open`) and the
        project-branch PixelCanvasWidget (registers `available`, consumes `open`). */}
    <PixelActivityProvider>
    {/* "View all" modal — mounted once in the shell, open-state bound to the
        provider's modalOpen/setModalOpen. The floating entry's "Open chat"
        action opens it via setModalOpen(true); there is no standalone route. */}
    <AgentConnectionsModal />
    {/* Daemon presence entry — the single bottom-right floating affordance
        (online-agent count + roster popover + direct open-chat). Mounted once
        here under AgentPresenceProvider so it is company-wide and appears on
        every dashboard page (replacing the sidebar pill). */}
    <DaemonPresenceEntry />
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
      {/* SSE: project pages get project-scoped events, /projects and /project-groups get company-wide, /settings gets none */}
      {isProjectContext && currentProjectUuid ? (
        <RealtimeProvider projectUuid={currentProjectUuid}>
          <main className="flex-1 flex flex-col overflow-auto pt-14 md:pt-0"><div className={`mx-auto w-full flex-1 flex flex-col ${isFullWidthPage ? "" : "max-w-[1200px]"}`}><PageTransition>{children}</PageTransition></div></main>
          <PixelCanvasWidget
            projectUuid={currentProjectUuid}
            projectName={currentProject?.name || ""}
          />
        </RealtimeProvider>
      ) : pathname === "/projects" || pathname.startsWith("/project-groups") ? (
        <RealtimeProvider>
          <main className="flex-1 flex flex-col overflow-auto pt-14 md:pt-0"><div className={`mx-auto w-full flex-1 flex flex-col ${isFullWidthPage ? "" : "max-w-[1200px]"}`}><PageTransition>{children}</PageTransition></div></main>
        </RealtimeProvider>
      ) : (
        <main className="flex-1 flex flex-col overflow-auto pt-14 md:pt-0"><div className={`mx-auto w-full flex-1 flex flex-col ${isFullWidthPage ? "" : "max-w-[1200px]"}`}><PageTransition>{children}</PageTransition></div></main>
      )}
    </div>
    </PixelActivityProvider>
    </AgentPresenceProvider>
    </AuthProvider>
    <Toaster position={isMobile ? "top-center" : "top-right"} closeButton={!isMobile} />
    </NotificationProvider>
  );
}
