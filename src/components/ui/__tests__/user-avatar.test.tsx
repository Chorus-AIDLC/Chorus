/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render as testingRender, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactElement } from "react"
import english from "../../../../messages/en.json"
import chinese from "../../../../messages/zh.json"

const { avatarCtorSpy, styleCtorSpy } = vi.hoisted(() => ({
  avatarCtorSpy: vi.fn(),
  styleCtorSpy: vi.fn(),
}))

vi.mock("@dicebear/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dicebear/core")>()
  return {
    ...actual,
    Avatar: class extends actual.Avatar {
      constructor(...args: ConstructorParameters<typeof actual.Avatar>) {
        avatarCtorSpy(args[1])
        super(...args)
      }
    },
    Style: class extends actual.Style {
      constructor(...args: ConstructorParameters<typeof actual.Style>) {
        styleCtorSpy(args[0])
        super(...args)
      }
    },
  }
})

import { getUserAvatarDataUri, UserAvatar } from "@/components/ui/user-avatar"

const SEED = "f77ea270-41af-491c-843a-ea40766fe7a1"
const DRAFT_SEED = "548c7d61-5bc8-4247-b294-8bd4d428630b"
let loadingImages: HTMLImageElement[]

function render(element: ReactElement, locale = "en") {
  return testingRender(element, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale={locale} messages={locale === "zh" ? chinese : english}>
        {children}
      </NextIntlClientProvider>
    ),
  })
}

it.each([["en", "User"], ["zh", "用户"]])("localizes missing-identity label in %s", (locale, label) => {
  render(<UserAvatar />, locale)
  expect(screen.getByRole("img", { name: label })).toBeTruthy()
})

function avatarRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="user-avatar"]')!
}

function avatarSource(): string | null {
  return avatarRoot().querySelector("img")?.getAttribute("src") ?? null
}

function finishImageLoading(event = "load") {
  act(() => {
    for (const image of loadingImages) image.dispatchEvent(new Event(event))
  })
}

beforeEach(() => {
  avatarCtorSpy.mockReset()
  loadingImages = []
  vi.stubGlobal("Image", class {
    constructor() {
      const image = document.createElement("img")
      loadingImages.push(image)
      return image
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("getUserAvatarDataUri", () => {
  it("falls back safely if style initialization fails and can recover", () => {
    styleCtorSpy.mockImplementationOnce(() => { throw new Error("Invalid style") })
    expect(getUserAvatarDataUri(SEED)).toBeNull()
    expect(getUserAvatarDataUri(SEED)).toMatch(/^data:image\/svg\+xml/)
    styleCtorSpy.mockClear()
    getUserAvatarDataUri(DRAFT_SEED)
    expect(styleCtorSpy).not.toHaveBeenCalled()
  })

  it("regenerates byte-identical local static SVGs from the same seed", () => {
    const first = getUserAvatarDataUri(SEED)!
    expect(first).toMatch(/^data:image\/svg\+xml/)
    expect(getUserAvatarDataUri(SEED)).toBe(first)
    expect(getUserAvatarDataUri(DRAFT_SEED)).not.toBe(first)
    expect(avatarCtorSpy).toHaveBeenCalledWith({ seed: SEED, tags: ["!animation"] })
    const svg = decodeURIComponent(first.slice(first.indexOf(",") + 1))
    expect(svg).not.toMatch(/@keyframes|animation:|<animate\b/)
    expect(svg).toContain("Personas by Draftbit")
    expect(svg).toContain("Draftbit - draftbit.com")
    expect(svg).toContain("https://personas.draftbit.com/")
    expect(svg).toContain("https://creativecommons.org/licenses/by/4.0/")
  })

  it("never requests a remote avatar", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "open")
    getUserAvatarDataUri(SEED)
    render(<UserAvatar name="Offline" avatarSeed={SEED} />)
    finishImageLoading()
    expect(avatarSource()).toMatch(/^data:image\/svg\+xml/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhrSpy).not.toHaveBeenCalled()
  })

  it.each([undefined, null, "", "   "])("does not generate from missing seed %s", (seed) => {
    expect(getUserAvatarDataUri(seed)).toBeNull()
    expect(avatarCtorSpy).not.toHaveBeenCalled()
  })

  it("returns null when avatar generation throws", () => {
    avatarCtorSpy.mockImplementationOnce(() => { throw new Error("Generation failed") })
    expect(getUserAvatarDataUri(SEED)).toBeNull()
  })
})

describe("UserAvatar", () => {
  it("uses only the seed, independent of identity, name, size and theme", () => {
    const { rerender } = render(<UserAvatar userUuid="first-user" name="Alice" avatarSeed={SEED} />)
    finishImageLoading()
    const source = avatarSource()
    expect(source).toBeTruthy()
    rerender(<UserAvatar userUuid="second-user" name="Renamed" avatarSeed={SEED} size="xs" className="dark" />)
    expect(avatarSource()).toBe(source)
    expect(avatarCtorSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("img", { name: "Renamed" })).toBe(avatarRoot())
    expect(avatarRoot().dataset.userUuid).toBe("second-user")
    expect(avatarRoot().className).toContain("dark")
    expect(avatarRoot().className).toContain("bg-muted")
    expect(avatarRoot().className).toContain("text-muted-foreground")
    expect(avatarRoot().querySelector("img")?.className).not.toMatch(/scale-|translate-/)
  })

  it("renders draft seeds without shared state or an identity lookup", () => {
    const { rerender } = render(<UserAvatar avatarSeed={SEED} />)
    finishImageLoading()
    const saved = avatarSource()
    rerender(<UserAvatar avatarSeed={DRAFT_SEED} />)
    finishImageLoading()
    expect(avatarSource()).not.toBe(saved)
    expect(avatarSource()).toBe(getUserAvatarDataUri(DRAFT_SEED))
    rerender(<UserAvatar avatarSeed={SEED} />)
    finishImageLoading()
    expect(avatarSource()).toBe(saved)
    expect(avatarRoot().dataset.motion).toBe("static")
  })

  it("memoizes only the current seed and does not retain preview history", () => {
    const { rerender, unmount } = render(<UserAvatar avatarSeed={SEED} />)
    for (let preview = 0; preview < 50; preview += 1) {
      rerender(<UserAvatar avatarSeed={`preview-${preview}`} />)
    }
    rerender(<UserAvatar avatarSeed={SEED} />)
    expect(avatarCtorSpy).toHaveBeenCalledTimes(52)
    rerender(<UserAvatar avatarSeed={SEED} name="Renamed" />)
    expect(avatarCtorSpy).toHaveBeenCalledTimes(52)
    unmount()
    render(<UserAvatar avatarSeed={SEED} />)
    expect(avatarCtorSpy).toHaveBeenCalledTimes(53)
  })

  it("falls back to initials rather than deriving a seed from name or identity", () => {
    render(<UserAvatar userUuid={SEED} name=" Alice " />)
    expect(screen.getByRole("img", { name: "Alice" }).textContent).toBe("A")
    expect(avatarSource()).toBeNull()
    expect(avatarCtorSpy).not.toHaveBeenCalled()
  })

  it("renders a safe user icon for missing identity and name", () => {
    render(<UserAvatar />)
    expect(screen.getByRole("img", { name: "User" }).querySelector("svg")).toBeTruthy()
    expect(avatarCtorSpy).not.toHaveBeenCalled()
  })

  it("falls back on generation failure and recovers with a new seed", () => {
    avatarCtorSpy.mockImplementationOnce(() => { throw new Error("Generation failed") })
    const { rerender } = render(<UserAvatar name="Alice" avatarSeed={SEED} />)
    expect(avatarRoot().textContent).toBe("A")
    expect(avatarSource()).toBeNull()
    rerender(<UserAvatar name="Alice" avatarSeed={DRAFT_SEED} />)
    finishImageLoading()
    expect(avatarSource()).toMatch(/^data:image\/svg\+xml/)
  })

  it("keeps the accessible fallback when image loading fails", () => {
    render(<UserAvatar name="Alice" avatarSeed={SEED} />)
    finishImageLoading("error")
    expect(screen.getByRole("img", { name: "Alice" }).textContent).toBe("A")
    expect(avatarSource()).toBeNull()
  })

  it("exposes one accessible name and allows localized labels", () => {
    render(<UserAvatar name="Alice" avatarSeed={SEED} aria-label="用户头像" />)
    finishImageLoading()
    expect(screen.getAllByRole("img")).toHaveLength(1)
    expect(screen.getByRole("img", { name: "用户头像" })).toBe(avatarRoot())
    expect(avatarRoot().querySelector("img")?.getAttribute("alt")).toBe("")
  })

  it.each([{ decorative: true }, { "aria-hidden": true }])("hides decorative avatars with %o", (flags) => {
    render(<UserAvatar name="Alice" avatarSeed={SEED} {...flags} />)
    finishImageLoading()
    expect(screen.queryByRole("img")).toBeNull()
    expect(avatarRoot().getAttribute("aria-hidden")).toBe("true")
    expect(avatarRoot().hasAttribute("aria-label")).toBe(false)
  })

  it.each([
    ["xs", 20], ["sm", 24], ["md", 32], ["lg", 40], [64, 64], [0, 32], [-1, 32], [NaN, 32],
  ] as const)("supports size %s at %s pixels", (size, pixels) => {
    render(<UserAvatar name="Alice" size={size} className="ring-2" />)
    expect(avatarRoot().style.width).toBe(`${pixels}px`)
    expect(avatarRoot().style.height).toBe(`${pixels}px`)
    expect(avatarRoot().className).toContain("ring-2")
  })
})
