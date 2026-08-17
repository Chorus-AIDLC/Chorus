// @vitest-environment jsdom
//
// AgentAvatar — the single shared source of agent-avatar rendering. These tests
// pin the DiceBear contract the whole feature relies on:
//
//   - determinism: same agent name → byte-identical avatar (same seed → same SVG);
//   - local-only generation: the avatar is built in-process, never over the network;
//   - reduced-motion: `prefers-reduced-motion: reduce` yields the STATIC form;
//   - memoization: generation runs once per distinct (name, form) key.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Count DiceBear Avatar constructions while delegating to the REAL implementation
// (so determinism / output stay authentic and only the call count is observed).
const { avatarCtorSpy } = vi.hoisted(() => ({ avatarCtorSpy: vi.fn() }))

vi.mock("@dicebear/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dicebear/core")>()
  const MockAvatar = function (this: unknown, style: unknown, options?: unknown) {
    avatarCtorSpy(options)
    return new actual.Avatar(style as never, options as never)
  } as unknown as typeof actual.Avatar
  return { ...actual, Avatar: MockAvatar }
})

import {
  AgentAvatar,
  getAgentAvatarDataUri,
  __clearAgentAvatarCache,
} from "@/components/ui/agent-avatar"

function decodeSvg(uri: string): string {
  const comma = uri.indexOf(",")
  return decodeURIComponent(uri.slice(comma + 1))
}

function mockMatchMedia(reduce: boolean) {
  const mql = {
    matches: reduce,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia
  return mql
}

function agentAvatarRoot(): HTMLElement {
  const el = document.querySelector('[data-slot="agent-avatar"]')
  if (!el) throw new Error("agent-avatar root not rendered")
  return el as HTMLElement
}

beforeEach(() => {
  __clearAgentAvatarCache()
  avatarCtorSpy.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("getAgentAvatarDataUri (local generation)", () => {
  it("is deterministic: same name + form → identical data URI", () => {
    const a = getAgentAvatarDataUri("Admin Claude", "animated")
    // clear the cache so the second call regenerates rather than reads the memo
    __clearAgentAvatarCache()
    const b = getAgentAvatarDataUri("Admin Claude", "animated")
    expect(a).toBeTruthy()
    expect(a).toBe(b)
  })

  it("differs by name (distinct seeds → distinct avatars)", () => {
    const claude = getAgentAvatarDataUri("Admin Claude", "animated")
    const codex = getAgentAvatarDataUri("Codex", "animated")
    expect(claude).not.toBe(codex)
  })

  it("animated form embeds a looping CSS animation; static form does not", () => {
    const animated = decodeSvg(getAgentAvatarDataUri("Codex", "animated")!)
    const still = decodeSvg(getAgentAvatarDataUri("Codex", "static")!)
    expect(animated).toContain("animation:")
    expect(animated).toContain("@keyframes")
    expect(still).not.toContain("animation:")
    expect(still).not.toContain("@keyframes")
  })

  it("makes no network request during generation", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, "open")
    __clearAgentAvatarCache()

    const uri = getAgentAvatarDataUri("Offline Agent", "animated")

    expect(uri).toMatch(/^data:image\/svg\+xml/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhrOpenSpy).not.toHaveBeenCalled()
  })

  it("memoizes: one generation per distinct (name, form) key", () => {
    getAgentAvatarDataUri("Memo Agent", "animated")
    getAgentAvatarDataUri("Memo Agent", "animated")
    getAgentAvatarDataUri("Memo Agent", "animated")
    // same key → generated exactly once
    expect(avatarCtorSpy).toHaveBeenCalledTimes(1)

    // a different form is a different key → one more generation
    getAgentAvatarDataUri("Memo Agent", "static")
    expect(avatarCtorSpy).toHaveBeenCalledTimes(2)

    // a different name is a different key → one more generation
    getAgentAvatarDataUri("Other Agent", "animated")
    expect(avatarCtorSpy).toHaveBeenCalledTimes(3)
  })
})

describe("AgentAvatar (component)", () => {
  it("renders the shared shadcn avatar container", () => {
    mockMatchMedia(false)
    render(<AgentAvatar name="Admin Claude" />)
    expect(agentAvatarRoot()).toBeTruthy()
  })

  it("animates by default when reduced motion is not requested", () => {
    mockMatchMedia(false)
    render(<AgentAvatar name="Admin Claude" />)
    expect(agentAvatarRoot().getAttribute("data-motion")).toBe("animated")
  })

  it("renders the STATIC form when prefers-reduced-motion is set", () => {
    mockMatchMedia(true)
    render(<AgentAvatar name="Admin Claude" />)
    expect(agentAvatarRoot().getAttribute("data-motion")).toBe("static")
  })

  it("renders the static form when animate={false} regardless of motion pref", () => {
    mockMatchMedia(false)
    render(<AgentAvatar name="Admin Claude" animate={false} />)
    expect(agentAvatarRoot().getAttribute("data-motion")).toBe("static")
  })

  it("maps preset and numeric sizes to fixed pixel dimensions", () => {
    mockMatchMedia(false)
    const { rerender } = render(<AgentAvatar name="Codex" size="sm" />)
    expect(agentAvatarRoot().style.width).toBe("24px")
    expect(agentAvatarRoot().style.height).toBe("24px")

    rerender(<AgentAvatar name="Codex" size={48} />)
    expect(agentAvatarRoot().style.width).toBe("48px")
    expect(agentAvatarRoot().style.height).toBe("48px")
  })
})
