// @vitest-environment jsdom
//
// The @-mention popup is position: fixed against the caret rect. When the editor
// moves without a Tiptap update (typing "@" while a Sheet is still sliding in, or
// an ancestor scrolling), the popup must follow the caret instead of staying at
// the rect captured at suggestion start (which can be off-screen).

import { describe, it, expect, afterEach } from "vitest";
import { positionSuggestionPopup, trackSuggestionPopup } from "@/components/mention-editor";

function rect(left: number, top: number, height = 20): DOMRect {
  return { left, top, bottom: top + height, right: left + 10, width: 10, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("positionSuggestionPopup", () => {
  it("places the popup below the caret when there is room", () => {
    const popup = document.createElement("div");
    positionSuggestionPopup(popup, () => rect(100, 50));
    expect(popup.style.position).toBe("fixed");
    expect(popup.style.left).toBe("100px");
    expect(popup.style.top).toBe("74px");
    expect(popup.style.bottom).toBe("");
  });

  it("flips above the caret near the viewport bottom and clears the stale top", () => {
    const popup = document.createElement("div");
    positionSuggestionPopup(popup, rect(100, 50));
    positionSuggestionPopup(popup, rect(100, window.innerHeight - 30));
    expect(popup.style.top).toBe("");
    expect(popup.style.bottom).toBe("34px");
  });

  it("ignores a missing rect", () => {
    const popup = document.createElement("div");
    positionSuggestionPopup(popup, () => null);
    positionSuggestionPopup(popup, undefined);
    expect(popup.style.left).toBe("");
  });
});

describe("trackSuggestionPopup", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("re-reads the caret rect after an animation/transition ends, a scroll, or a resize", () => {
    const popup = document.createElement("div");
    let caret = rect(1380, 100); // captured mid slide-in: outside a 1280px viewport
    positionSuggestionPopup(popup, caret);
    stop = trackSuggestionPopup(popup, () => caret);

    caret = rect(1040, 100); // Sheet settled
    const sheet = document.createElement("div");
    document.body.appendChild(sheet);
    sheet.dispatchEvent(new Event("animationend", { bubbles: false }));
    expect(popup.style.left).toBe("1040px");

    caret = rect(900, 100);
    sheet.dispatchEvent(new Event("transitionend", { bubbles: false }));
    expect(popup.style.left).toBe("900px");

    caret = rect(800, 100);
    sheet.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(popup.style.left).toBe("800px");

    caret = rect(700, 100);
    window.dispatchEvent(new Event("resize"));
    expect(popup.style.left).toBe("700px");
    sheet.remove();
  });

  it("stops repositioning after cleanup", () => {
    const popup = document.createElement("div");
    let caret = rect(10, 10);
    stop = trackSuggestionPopup(popup, () => caret);
    stop();
    stop = undefined;
    caret = rect(500, 10);
    document.dispatchEvent(new Event("animationend"));
    window.dispatchEvent(new Event("resize"));
    expect(popup.style.left).toBe("");
  });
});
