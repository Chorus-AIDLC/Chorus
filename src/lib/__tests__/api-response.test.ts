import { describe, it, expect } from 'vitest';
import { success, paginated, error, errors, ErrorCode } from '../api-response';

describe('success', () => {
  it('returns NextResponse with success: true and data', async () => {
    const data = { id: 1, name: 'test' };
    const response = success(data);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(data);
  });

  it('includes optional meta when provided', async () => {
    const response = success({ items: [] }, { page: 1, pageSize: 10, total: 0 });
    const body = await response.json();

    expect(body.meta).toEqual({ page: 1, pageSize: 10, total: 0 });
  });

  it('meta is undefined when not provided', async () => {
    const response = success('hello');
    const body = await response.json();

    expect(body.meta).toBeUndefined();
  });
});

describe('paginated', () => {
  it('returns correct meta fields', async () => {
    const data = [{ id: 1 }, { id: 2 }];
    const response = paginated(data, 2, 10, 50);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(data);
    expect(body.meta).toEqual({ page: 2, pageSize: 10, total: 50 });
  });

  it('works with empty data array', async () => {
    const response = paginated([], 1, 20, 0);
    const body = await response.json();

    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});

describe('error', () => {
  it('returns error response with correct status code', async () => {
    const response = error(ErrorCode.BAD_REQUEST, 'bad input');
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('bad input');
  });

  it('includes details when provided', async () => {
    const details = { field: 'name', issue: 'required' };
    const response = error(ErrorCode.VALIDATION_ERROR, 'Validation failed', details);
    const body = await response.json();

    expect(body.error.details).toEqual(details);
  });
});

describe('errors helpers', () => {
  it('badRequest returns 400', async () => {
    const response = errors.badRequest('invalid');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('invalid');
  });

  it('unauthorized returns 401 with default message', async () => {
    const response = errors.unauthorized();
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBe('Authentication required');
  });

  it('unauthorized accepts custom message', async () => {
    const response = errors.unauthorized('Token expired');
    const body = await response.json();
    expect(body.error.message).toBe('Token expired');
  });

  it('forbidden returns 403 with default message', async () => {
    const response = errors.forbidden();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('Access denied');
  });

  it('notFound returns 404', async () => {
    const response = errors.notFound('Task');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Task not found');
  });

  it('notFound uses default "Resource" when no arg', async () => {
    const response = errors.notFound();
    const body = await response.json();
    expect(body.error.message).toBe('Resource not found');
  });

  it('conflict returns 409', async () => {
    const response = errors.conflict('Duplicate entry');
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('validationError returns 422', async () => {
    const response = errors.validationError({ fields: ['name'] });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual({ fields: ['name'] });
  });

  it('alreadyClaimed returns 409', async () => {
    const response = errors.alreadyClaimed();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('ALREADY_CLAIMED');
  });

  it('notClaimed returns 400', async () => {
    const response = errors.notClaimed();
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_CLAIMED');
  });

  it('invalidStatusTransition returns 400 with from/to', async () => {
    const response = errors.invalidStatusTransition('open', 'closed');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toBe('Invalid status transition from open to closed');
  });

  it('permissionDenied returns 403', async () => {
    const response = errors.permissionDenied('delete project');
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
    expect(body.error.message).toBe('Permission denied: delete project');
  });

  it('internal returns 500', async () => {
    const response = errors.internal();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('database returns 500', async () => {
    const response = errors.database();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('DATABASE_ERROR');
  });
});
