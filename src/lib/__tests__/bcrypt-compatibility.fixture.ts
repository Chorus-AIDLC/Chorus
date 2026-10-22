export const legacyBcryptGenerator = "bcryptjs@2.4.3";

export const legacyBcryptFixtures = {
  localAscii: {
    name: "localAscii",
    password: "a-valid-password-123",
    salt: "$2a$12$abcdefghijklmnopqrstuu",
    hash: "$2a$12$abcdefghijklmnopqrstuuUqoFixg0RmAMZhoIk4qOb9jicIHDm82",
  },
  localUtf8Boundary: {
    name: "localUtf8Boundary",
    password: "密".repeat(24),
    salt: "$2a$12$abcdefghijklmnopqrstuu",
    hash: "$2a$12$abcdefghijklmnopqrstuuRXGZBNTeUMWAcnZO0UKFbCqFQx.gzDe",
  },
  superAdmin: {
    password: "legacy-admin-password-123",
    salt: "$2a$10$abcdefghijklmnopqrstuu",
    hash: "$2a$10$abcdefghijklmnopqrstuu1pKfXlC2/FpV7zDvRct9dk/OtRkX7Im",
  },
} as const;

export const legacyLocalFixtures = [legacyBcryptFixtures.localAscii, legacyBcryptFixtures.localUtf8Boundary];
