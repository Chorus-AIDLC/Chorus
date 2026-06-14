// Unit tests for the Idea List → Dashboard redirect mapping.
//
// The Idea List page was removed; its two RESTful URLs are 308-redirected into
// the Dashboard. These tests pin the exact mapping the middleware relies on.

import { describe, it, expect } from "vitest";
import { resolveIdeaRedirect } from "../idea-url-redirect";

const P = "11111111-1111-4111-8111-111111111111";
const IDEA = "22222222-2222-4222-8222-222222222222";

describe("resolveIdeaRedirect — list URL", () => {
  it("maps /projects/:p/ideas to the Dashboard with no panel", () => {
    expect(resolveIdeaRedirect(`/projects/${P}/ideas`, null)).toEqual({
      pathname: `/projects/${P}/dashboard`,
      panel: null,
    });
  });

  it("tolerates a trailing slash on the list URL", () => {
    expect(resolveIdeaRedirect(`/projects/${P}/ideas/`, null)).toEqual({
      pathname: `/projects/${P}/dashboard`,
      panel: null,
    });
  });
});

describe("resolveIdeaRedirect — detail URL", () => {
  it("maps /projects/:p/ideas/:ideaUuid to the Dashboard panel", () => {
    expect(resolveIdeaRedirect(`/projects/${P}/ideas/${IDEA}`, null)).toEqual({
      pathname: `/projects/${P}/dashboard`,
      panel: IDEA,
    });
  });

  it("tolerates a trailing slash on the detail URL", () => {
    expect(resolveIdeaRedirect(`/projects/${P}/ideas/${IDEA}/`, null)).toEqual({
      pathname: `/projects/${P}/dashboard`,
      panel: IDEA,
    });
  });

  it("takes precedence over a stray ?idea= param on a detail URL", () => {
    // The detail path wins; the legacy param is ignored when a path id exists.
    expect(resolveIdeaRedirect(`/projects/${P}/ideas/${IDEA}`, "other")).toEqual({
      pathname: `/projects/${P}/dashboard`,
      panel: IDEA,
    });
  });
});

describe("resolveIdeaRedirect — legacy ?idea= collapses to one hop", () => {
  it("maps /projects/:p/ideas?idea=:id straight to the Dashboard panel", () => {
    // The old behavior was a two-hop 307 (→ /ideas/{id} → ...). Now one 308.
    expect(resolveIdeaRedirect(`/projects/${P}/ideas`, IDEA)).toEqual({
      pathname: `/projects/${P}/dashboard`,
      panel: IDEA,
    });
  });

  it("ignores an empty ?idea= value and falls back to no panel", () => {
    expect(resolveIdeaRedirect(`/projects/${P}/ideas`, "")).toEqual({
      pathname: `/projects/${P}/dashboard`,
      panel: null,
    });
  });
});

describe("resolveIdeaRedirect — non-idea paths are not matched", () => {
  it.each([
    `/projects/${P}/dashboard`,
    `/projects/${P}/tasks`,
    `/projects/${P}/tasks/${IDEA}`,
    `/projects/${P}/documents`,
    `/projects/${P}/ideas-archive`, // must not over-match a sibling route
    `/projects/${P}/ideasfoo`,
    `/projects`,
    `/settings`,
  ])("returns null for %s", (pathname) => {
    expect(resolveIdeaRedirect(pathname, null)).toBeNull();
  });

  it("does not match a deeper idea sub-resource", () => {
    // Only a single detail segment is a redirect; deeper paths are not.
    expect(resolveIdeaRedirect(`/projects/${P}/ideas/${IDEA}/elaboration`, null)).toBeNull();
  });
});
