import type React from "react";

export function isImeComposing(
  e: React.KeyboardEvent | KeyboardEvent
): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing || e.keyCode === 229;
}
