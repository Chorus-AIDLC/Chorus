import { describe, it, expect } from 'vitest';
import { getAgentColor, AGENT_COLOR_PALETTE } from '../agent-color';

describe('getAgentColor', () => {
  it('returns the same color for the same name', () => {
    const color1 = getAgentColor('Dev Agent');
    const color2 = getAgentColor('Dev Agent');
    expect(color1).toBe(color2);
  });

  it('returns a color from the palette', () => {
    const color = getAgentColor('PM Agent');
    expect(AGENT_COLOR_PALETTE).toContain(color);
  });

  it('returns different colors for different names', () => {
    const names = [
      'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon',
      'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa',
    ];
    const colors = names.map(getAgentColor);
    const uniqueColors = new Set(colors);
    // With 10 names and 12 palette entries, we expect reasonable distribution
    // At least 5 unique colors (would be extremely unlikely to get fewer)
    expect(uniqueColors.size).toBeGreaterThanOrEqual(5);
  });

  it('has at least 12 colors in the palette', () => {
    expect(AGENT_COLOR_PALETTE.length).toBeGreaterThanOrEqual(12);
  });

  it('all palette colors are valid hex strings', () => {
    for (const color of AGENT_COLOR_PALETTE) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('handles empty string', () => {
    const color = getAgentColor('');
    expect(AGENT_COLOR_PALETTE).toContain(color);
  });

  it('handles unicode names', () => {
    const color = getAgentColor('开发助手');
    expect(AGENT_COLOR_PALETTE).toContain(color);
    expect(getAgentColor('开发助手')).toBe(color);
  });
});
