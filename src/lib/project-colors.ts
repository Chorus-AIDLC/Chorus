// Unified pastel icon color palette — deterministic by project name.
// Used wherever a project avatar/icon is rendered to ensure consistency.
const PROJECT_ICON_COLORS = [
  { bg: "#F5C4B3", text: "#712B13" }, // Coral
  { bg: "#FAC775", text: "#633806" }, // Amber
  { bg: "#CECBF6", text: "#3C3489" }, // Purple
  { bg: "#B5D4F4", text: "#0C447C" }, // Blue
  { bg: "#C0DD97", text: "#27500A" }, // Green
  { bg: "#9FE1CB", text: "#085041" }, // Teal
  { bg: "#F4C0D1", text: "#72243E" }, // Pink
  { bg: "#FADBB5", text: "#6B3A10" }, // Peach
];

export function getProjectInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function getProjectIconColor(name: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PROJECT_ICON_COLORS[Math.abs(hash) % PROJECT_ICON_COLORS.length];
}
