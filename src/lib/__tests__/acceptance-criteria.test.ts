import { describe, it, expect } from 'vitest';
import {
  normalizeAcceptanceCriteria,
  hasNonEmptyAcceptanceCriteria,
  ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE,
} from '../acceptance-criteria';

describe('normalizeAcceptanceCriteria', () => {
  it('returns [] for undefined', () => {
    expect(normalizeAcceptanceCriteria(undefined)).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(normalizeAcceptanceCriteria(null)).toEqual([]);
  });

  it('returns [] for an empty array', () => {
    expect(normalizeAcceptanceCriteria([])).toEqual([]);
  });

  it('drops items whose description is blank after trimming', () => {
    const result = normalizeAcceptanceCriteria([
      { description: '   ' },
      { description: '\t\n' },
      { description: '' },
    ]);
    expect(result).toEqual([]);
  });

  it('trims surviving descriptions and defaults required to true', () => {
    const result = normalizeAcceptanceCriteria([
      { description: '  has trailing space  ' },
    ]);
    expect(result).toEqual([{ description: 'has trailing space', required: true }]);
  });

  it('preserves an explicit required: false', () => {
    const result = normalizeAcceptanceCriteria([
      { description: 'optional one', required: false },
    ]);
    expect(result).toEqual([{ description: 'optional one', required: false }]);
  });

  it('keeps non-blank items in order while dropping blanks (mixed)', () => {
    const result = normalizeAcceptanceCriteria([
      { description: 'first' },
      { description: '   ' },
      { description: 'second', required: false },
    ]);
    expect(result).toEqual([
      { description: 'first', required: true },
      { description: 'second', required: false },
    ]);
  });
});

describe('hasNonEmptyAcceptanceCriteria', () => {
  it('returns false for undefined', () => {
    expect(hasNonEmptyAcceptanceCriteria(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasNonEmptyAcceptanceCriteria(null)).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(hasNonEmptyAcceptanceCriteria([])).toBe(false);
  });

  it('returns false when every description is blank', () => {
    expect(
      hasNonEmptyAcceptanceCriteria([{ description: '  ' }, { description: '\n' }]),
    ).toBe(false);
  });

  it('returns true when at least one description is non-blank', () => {
    expect(
      hasNonEmptyAcceptanceCriteria([{ description: '  ' }, { description: 'real' }]),
    ).toBe(true);
  });

  it('returns true for a single non-blank item', () => {
    expect(hasNonEmptyAcceptanceCriteria([{ description: 'done' }])).toBe(true);
  });
});

describe('ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE', () => {
  it('is a non-empty string', () => {
    expect(typeof ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE).toBe('string');
    expect(ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE.length).toBeGreaterThan(0);
  });
});
