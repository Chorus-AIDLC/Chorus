import type { CSSProperties } from "react";

// Unified icon color palette — deterministic by project name.
// Used wherever a project avatar/icon is rendered to ensure consistency.
//
// Each entry carries BOTH a light-theme pair (pastel bg + deep text) and a
// dark-theme pair (deep muted bg + light text). Canvas/inline consumers can't
// read CSS tokens, so the picker returns both and callers apply them via CSS
// custom properties (see `projectIconStyle`) — a scoped rule in globals.css
// swaps light↔dark by the `.dark` class on <html>.
export interface ProjectIconColor {
  bg: string;
  text: string;
  darkBg: string;
  darkText: string;
}

const PROJECT_ICON_COLORS: ProjectIconColor[] = [
  { bg: "#F5C4B3", text: "#712B13", darkBg: "#4a2a1e", darkText: "#F5C4B3" }, // Coral
  { bg: "#FAC775", text: "#633806", darkBg: "#4a3a1a", darkText: "#FAD79B" }, // Amber
  { bg: "#CECBF6", text: "#3C3489", darkBg: "#2f2c52", darkText: "#CECBF6" }, // Purple
  { bg: "#B5D4F4", text: "#0C447C", darkBg: "#1e3450", darkText: "#B5D4F4" }, // Blue
  { bg: "#C0DD97", text: "#27500A", darkBg: "#2c3d1c", darkText: "#C0DD97" }, // Green
  { bg: "#9FE1CB", text: "#085041", darkBg: "#183d34", darkText: "#9FE1CB" }, // Teal
  { bg: "#F4C0D1", text: "#72243E", darkBg: "#48242f", darkText: "#F4C0D1" }, // Pink
  { bg: "#FADBB5", text: "#6B3A10", darkBg: "#463421", darkText: "#FADBB5" }, // Peach
];

export function getProjectInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function getProjectIconColor(name: string): ProjectIconColor {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PROJECT_ICON_COLORS[Math.abs(hash) % PROJECT_ICON_COLORS.length];
}

// Build an inline style that exposes the light + dark pairs as CSS custom
// properties. The `.project-icon` rule in globals.css consumes them and picks
// the dark pair under `.dark`. Cast to a plain style object for JSX.
export function projectIconStyle(c: ProjectIconColor): CSSProperties {
  return {
    ["--icon-bg" as string]: c.bg,
    ["--icon-text" as string]: c.text,
    ["--icon-bg-dark" as string]: c.darkBg,
    ["--icon-text-dark" as string]: c.darkText,
  };
}
