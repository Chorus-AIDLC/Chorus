## Why

The application and CDK still depend on bcryptjs 2.4.3. Upgrade both to the maintained 3.x line with bundled types without changing credential behavior. This is dependency maintenance, not a security incident response.

## What Changes

- Declare `bcryptjs: ^3.0.3` in the root and `packages/chorus-cdk/package.json`, regenerate the pnpm lockfile, and remove both obsolete `@types/bcryptjs` declarations.
- Preserve application asynchronous hashing/comparison and CDK synchronous hashing, work factors 12 and 10 respectively, password validation, and pure-JavaScript distribution.
- Add reproducible synthetic bcryptjs 2.4.3 hash fixtures and regression coverage through local credential verification, workspace login, and super-admin verification.
- Check module/type compatibility, focused and full tests, and application/CDK builds. Report unrelated baseline failures separately rather than expanding scope.

## Capabilities

### New Capabilities

- `bcrypt-credential-compatibility`: Cross-version credential and runtime compatibility guarantees for application and deployment-generated bcrypt hashes.

### Modified Capabilities

None. Existing local password/authentication requirements remain unchanged.

## Impact

Root/CDK manifests, pnpm lockfile, authentication tests and synthetic fixtures. No schema migration, API change, UI change, native module, password reset, or opportunistic rehash. User explicitly selected workspace-wide scope and caret version policy; YOLO authorizes completion through independent review, not git push or merge.
