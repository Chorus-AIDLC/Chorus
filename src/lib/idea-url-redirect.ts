// Redirect mapping for the removed Idea List page.
//
// The standalone Idea List page (/projects/[uuid]/ideas and
// /projects/[uuid]/ideas/[ideaUuid]) was removed — idea browsing lives in the
// Dashboard's Idea Tracker. To keep shared links and bookmarks working, the two
// RESTful idea URLs are redirected (308, permanent) into the equivalent
// Dashboard address:
//
//   /projects/:p/ideas                 → /projects/:p/dashboard
//   /projects/:p/ideas/:ideaUuid       → /projects/:p/dashboard?panel=:ideaUuid
//   /projects/:p/ideas?idea=:id        → /projects/:p/dashboard?panel=:id   (legacy, one hop)
//
// The Dashboard opens an idea's side panel via the `?panel=` query param (see
// usePanelUrl), so that's the canonical detail address we target.
//
// This is a pure function so it can be unit-tested without constructing a full
// NextRequest; the middleware adapts its result to a NextResponse.redirect.

export interface IdeaRedirectTarget {
  /** Destination pathname, e.g. `/projects/abc/dashboard`. */
  pathname: string;
  /** Value for the `?panel=` query param, or null when none (list redirect). */
  panel: string | null;
}

const LIST_RE = /^\/projects\/([^/]+)\/ideas\/?$/;
const DETAIL_RE = /^\/projects\/([^/]+)\/ideas\/([^/]+)\/?$/;

/**
 * Resolve the Dashboard redirect target for a legacy idea URL.
 *
 * @param pathname     request pathname (no query string)
 * @param legacyIdea   the `?idea=` query param value, if present on the list URL
 * @returns the redirect target, or null when the path is not an idea-list URL
 */
export function resolveIdeaRedirect(
  pathname: string,
  legacyIdea?: string | null,
): IdeaRedirectTarget | null {
  // Detail URL: /projects/:p/ideas/:ideaUuid → dashboard panel.
  const detail = pathname.match(DETAIL_RE);
  if (detail) {
    return { pathname: `/projects/${detail[1]}/dashboard`, panel: detail[2] };
  }

  // List URL: /projects/:p/ideas → dashboard, opening the panel directly when
  // a legacy ?idea= param is present (collapses the old two-hop redirect).
  const list = pathname.match(LIST_RE);
  if (list) {
    const dashboard = `/projects/${list[1]}/dashboard`;
    return { pathname: dashboard, panel: legacyIdea ? legacyIdea : null };
  }

  return null;
}
