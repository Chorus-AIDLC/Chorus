import { z } from "zod";

export const DISPLAY_NAME_MAX_LENGTH = 32;

export function displayNameLength(value: string): number {
  return Array.from(value.trim()).length;
}

export const displayNameSchema = z.string().trim().refine(
  value => {
    const length = displayNameLength(value);
    return length >= 1 && length <= DISPLAY_NAME_MAX_LENGTH;
  },
  { message: `Name must contain 1–${DISPLAY_NAME_MAX_LENGTH} Unicode code points` },
).refine(
  value => !/[\u0000\uD800-\uDFFF]/u.test(value),
  { message: "Name must not contain NUL or unpaired surrogates" },
);
