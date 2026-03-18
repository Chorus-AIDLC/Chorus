import { describe, it, expect, vi } from 'vitest';
import { parsePagination, withErrorHandler, parseBody, parseQuery, ApiError } from '../api-handler';
import { NextRequest, NextResponse } from 'next/server';

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

describe('withErrorHandler', () => {
  it('calls handler and returns its response on success', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ success: true, data: 'ok' }));
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(handler).toHaveBeenCalledWith(req, context);
    const body = await response.json();
    expect(body).toEqual({ success: true, data: 'ok' });
  });

  it('handles ApiError and returns formatted error response', async () => {
    const handler = vi.fn().mockRejectedValue(
      new ApiError('NOT_FOUND', 'Resource not found', 404, { id: '123' })
    );
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        details: { id: '123' },
      },
    });
  });

  it('handles Prisma P2025 (record not found) error', async () => {
    const handler = vi.fn().mockRejectedValue({
      code: 'P2025',
      meta: { cause: 'Record not found' },
    });
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('handles Prisma P2002 (unique constraint violation) error', async () => {
    const handler = vi.fn().mockRejectedValue({
      code: 'P2002',
      meta: { target: ['email'] },
    });
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('Unique constraint violation');
  });

  it('handles Prisma P2003 (foreign key constraint violation) error', async () => {
    const handler = vi.fn().mockRejectedValue({
      code: 'P2003',
      meta: { field_name: 'companyId' },
    });
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('DATABASE_ERROR');
    expect(body.error.message).toContain('Foreign key constraint violation');
  });

  it('handles generic Error in production mode', async () => {
    const originalEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

    const handler = vi.fn().mockRejectedValue(new Error('Database connection failed'));
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');

    (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
  });

  it('handles generic Error in development mode with error message', async () => {
    const originalEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';

    const handler = vi.fn().mockRejectedValue(new Error('Database connection failed'));
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Database connection failed');

    (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
  });

  it('handles unknown error types', async () => {
    const handler = vi.fn().mockRejectedValue('string error');
    const wrappedHandler = withErrorHandler(handler);

    const req = makeRequest('/api/test');
    const context = { params: Promise.resolve({}) };
    const response = await wrappedHandler(req, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('parseBody', () => {
  it('parses valid JSON body', async () => {
    const body = JSON.stringify({ name: 'test', value: 123 });
    const req = new NextRequest('http://localhost:3000/api/test', {
      method: 'POST',
      body,
    });

    const result = await parseBody<{ name: string; value: number }>(req);

    expect(result).toEqual({ name: 'test', value: 123 });
  });

  it('throws ApiError for invalid JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/test', {
      method: 'POST',
      body: 'invalid json{',
    });

    await expect(parseBody(req)).rejects.toThrow(ApiError);
    await expect(parseBody(req)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON body',
      status: 400,
    });
  });

  it('throws ApiError for empty body', async () => {
    const req = new NextRequest('http://localhost:3000/api/test', {
      method: 'POST',
      body: '',
    });

    await expect(parseBody(req)).rejects.toThrow(ApiError);
  });
});

describe('parseQuery', () => {
  it('parses query parameters', () => {
    const req = makeRequest('/api/test?page=2&status=active&tag=urgent');
    const result = parseQuery(req);

    expect(result).toEqual({
      page: '2',
      status: 'active',
      tag: 'urgent',
    });
  });

  it('returns empty object for no query parameters', () => {
    const req = makeRequest('/api/test');
    const result = parseQuery(req);

    expect(result).toEqual({});
  });

  it('handles duplicate query parameters (keeps last value)', () => {
    const req = makeRequest('/api/test?key=first&key=second');
    const result = parseQuery(req);

    expect(result).toEqual({ key: 'second' });
  });

  it('handles URL-encoded values', () => {
    const req = makeRequest('/api/test?message=hello%20world&symbol=%26');
    const result = parseQuery(req);

    expect(result).toEqual({
      message: 'hello world',
      symbol: '&',
    });
  });
});
