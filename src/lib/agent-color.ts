// Deterministic agent color assignment from agent name.
// Colors are chosen to be distinguishable on both light and dark backgrounds.

export const AGENT_COLOR_PALETTE = [
  "#E06C75", // soft red
  "#E5C07B", // warm yellow
  "#98C379", // green
  "#56B6C2", // cyan
  "#61AFEF", // blue
  "#C678DD", // purple
  "#D19A66", // orange
  "#BE5046", // dark red
  "#7EC8E3", // sky blue
  "#C3E88D", // lime
  "#F78C6C", // coral
  "#A9DC76", // bright green
] as const;

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

export function getAgentColor(agentName: string): string {
  const index = hashString(agentName) % AGENT_COLOR_PALETTE.length;
  return AGENT_COLOR_PALETTE[index];
}
