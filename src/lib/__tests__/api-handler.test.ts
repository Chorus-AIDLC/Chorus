import { describe, it, expect } from 'vitest';
import { parsePagination } from '../api-handler';
import { NextRequest } from 'next/server';

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('parsePagination', () => {
  it('returns defaults when no query params', () => {
    const req = makeRequest('/api/tasks');
    const result = parsePagination(req);

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.skip).toBe(0);
    expect(result.take).toBe(20);
  });

  it('parses custom page and pageSize', () => {
    const req = makeRequest('/api/tasks?page=3&pageSize=10');
    const result = parsePagination(req);

    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
    expect(result.skip).toBe(20); // (3-1) * 10
    expect(result.take).toBe(10);
  });

  it('clamps page to minimum of 1', () => {
    const req = makeRequest('/api/tasks?page=0');
    const result = parsePagination(req);

    expect(result.page).toBe(1);
    expect(result.skip).toBe(0);
  });

  it('clamps negative page to 1', () => {
    const req = makeRequest('/api/tasks?page=-5');
    const result = parsePagination(req);

    expect(result.page).toBe(1);
  });

  it('clamps pageSize to minimum of 1', () => {
    const req = makeRequest('/api/tasks?pageSize=0');
    const result = parsePagination(req);

    expect(result.pageSize).toBe(1);
  });

  it('clamps pageSize to maximum of 100', () => {
    const req = makeRequest('/api/tasks?pageSize=500');
    const result = parsePagination(req);

    expect(result.pageSize).toBe(100);
  });

  it('calculates skip correctly for page 2', () => {
    const req = makeRequest('/api/tasks?page=2&pageSize=25');
    const result = parsePagination(req);

    expect(result.skip).toBe(25); // (2-1) * 25
  });

  it('handles non-numeric values gracefully (NaN propagates)', () => {
    const req = makeRequest('/api/tasks?page=abc&pageSize=xyz');
    const result = parsePagination(req);

    // parseInt("abc") => NaN, Math.max(1, NaN) => NaN
    expect(result.page).toBeNaN();
    expect(result.pageSize).toBeNaN();
  });
});
