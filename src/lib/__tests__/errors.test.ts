import { describe, it, expect } from 'vitest';
import { isPrismaNotFound, AlreadyClaimedError, NotClaimedError } from '../errors';

describe('isPrismaNotFound', () => {
  it('returns true for object with code P2025', () => {
    expect(isPrismaNotFound({ code: 'P2025' })).toBe(true);
  });

  it('returns false for object with different Prisma code', () => {
    expect(isPrismaNotFound({ code: 'P2002' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isPrismaNotFound(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPrismaNotFound(undefined)).toBe(false);
  });

  it('returns false for a plain string', () => {
    expect(isPrismaNotFound('P2025')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isPrismaNotFound(42)).toBe(false);
  });

  it('returns false for an object without code property', () => {
    expect(isPrismaNotFound({ message: 'not found' })).toBe(false);
  });

  it('returns true even with extra properties', () => {
    expect(isPrismaNotFound({ code: 'P2025', meta: { cause: 'Record not found' } })).toBe(true);
  });
});

describe('AlreadyClaimedError', () => {
  it('is an instance of Error', () => {
    const err = new AlreadyClaimedError('Task');
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const err = new AlreadyClaimedError('Task');
    expect(err.name).toBe('AlreadyClaimedError');
  });

  it('includes entity name in message', () => {
    const err = new AlreadyClaimedError('Idea');
    expect(err.message).toBe('Idea is already claimed');
  });
});

describe('NotClaimedError', () => {
  it('is an instance of Error', () => {
    const err = new NotClaimedError('Task');
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const err = new NotClaimedError('Task');
    expect(err.name).toBe('NotClaimedError');
  });

  it('includes entity name in message', () => {
    const err = new NotClaimedError('Idea');
    expect(err.message).toBe('Idea is not currently claimed');
  });
});
