// Mock for @/generated/prisma/client used in vitest
// Provides stub PrismaClient and Prisma namespace for tests

export class PrismaClient {
  constructor() {
    // no-op
  }
  $extends() {
    return this;
  }
}

export const Prisma = {
  JsonNull: "DbNull",
  DbNull: "DbNull",
  JsonValue: undefined,
  InputJsonValue: undefined,
};
