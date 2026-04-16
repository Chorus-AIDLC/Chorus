// src/lib/api-handler.ts
// API Error Handling Middleware (ARCHITECTURE.md §5.1)

import { NextRequest, NextResponse } from "next/server";
import { errors } from "./api-response";
import { createRequestLogger } from "./logger";
import { requestContext, getRequestLogger } from "./request-context";

// API Handler type
export type ApiHandler<T = Record<string, string>> = (
  request: NextRequest,
  context: { params: Promise<T> }
) => Promise<NextResponse>;

// Custom API Error class
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Prisma error codes
const PRISMA_ERROR_CODES = {
  P2002: "Unique constraint violation",
  P2025: "Record not found",
  P2003: "Foreign key constraint violation",
};

// Error handling wrapper
export function withErrorHandler<T = Record<string, string>>(
  handler: ApiHandler<T>
): ApiHandler<T> {
  return async (request, context) => {
    const requestId = crypto.randomUUID();
    const reqLogger = createRequestLogger({ requestId });

    return requestContext.run({ requestId, logger: reqLogger }, async () => {
      try {
        return await handler(request, context);
      } catch (err) {
        getRequestLogger().error({ err }, "API error");

        // Custom API error
        if (err instanceof ApiError) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: err.code,
                message: err.message,
                details: err.details,
              },
            },
            { status: err.status }
          );
        }

        // Prisma error
        if (err && typeof err === "object" && "code" in err) {
          const prismaErr = err as { code: string; meta?: unknown };
          const errorMessage =
            PRISMA_ERROR_CODES[
              prismaErr.code as keyof typeof PRISMA_ERROR_CODES
            ];

          if (errorMessage) {
            if (prismaErr.code === "P2025") {
              return errors.notFound();
            }
            if (prismaErr.code === "P2002") {
              return errors.conflict(errorMessage);
            }
            return errors.database(errorMessage);
          }
        }

        // Generic error
        if (err instanceof Error) {
          return errors.internal(
            process.env.NODE_ENV === "development"
              ? err.message
              : "Internal server error"
          );
        }

        return errors.internal();
      }
    });
  };
}

// Request body parser utility
export async function parseBody<T>(request: NextRequest): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError("BAD_REQUEST", "Invalid JSON body", 400);
  }
}

// Query parameter parser utility
export function parseQuery(request: NextRequest) {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

// Pagination parameter parser
export function parsePagination(request: NextRequest) {
  const query = parseQuery(request);
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || "20", 10)));
  const skip = (page - 1) * pageSize;

  return { page, pageSize, skip, take: pageSize };
}
