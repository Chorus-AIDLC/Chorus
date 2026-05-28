import { describe, it, expect } from "vitest";
import type React from "react";
import { isImeComposing } from "../ime";

type ReactKeyboardEventLike = Pick<
  React.KeyboardEvent,
  "nativeEvent" | "keyCode"
>;

function makeReactEvent(
  isComposing: boolean,
  keyCode: number
): ReactKeyboardEventLike {
  return {
    nativeEvent: { isComposing, keyCode } as KeyboardEvent,
    keyCode,
  };
}

function makeNativeEvent(
  isComposing: boolean,
  keyCode: number
): KeyboardEvent {
  return { isComposing, keyCode } as KeyboardEvent;
}

describe("isImeComposing", () => {
  it("returns true for React event with nativeEvent.isComposing=true", () => {
    const e = makeReactEvent(true, 65);
    expect(isImeComposing(e as React.KeyboardEvent)).toBe(true);
  });

  it("returns true for React event with isComposing=false but keyCode=229", () => {
    const e = makeReactEvent(false, 229);
    expect(isImeComposing(e as React.KeyboardEvent)).toBe(true);
  });

  it("returns false for React event with isComposing=false and keyCode=13 (Enter)", () => {
    const e = makeReactEvent(false, 13);
    expect(isImeComposing(e as React.KeyboardEvent)).toBe(false);
  });

  it("returns false for React event with isComposing=false and keyCode=65 (non-Enter)", () => {
    const e = makeReactEvent(false, 65);
    expect(isImeComposing(e as React.KeyboardEvent)).toBe(false);
  });

  it("returns true for raw KeyboardEvent with isComposing=true", () => {
    const e = makeNativeEvent(true, 65);
    expect(isImeComposing(e)).toBe(true);
  });

  it("returns true for raw KeyboardEvent with isComposing=false and keyCode=229", () => {
    const e = makeNativeEvent(false, 229);
    expect(isImeComposing(e)).toBe(true);
  });

  it("returns false for raw KeyboardEvent with isComposing=false and keyCode=13", () => {
    const e = makeNativeEvent(false, 13);
    expect(isImeComposing(e)).toBe(false);
  });
});
