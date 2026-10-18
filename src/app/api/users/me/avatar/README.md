# Current user's generated avatar

`PATCH /api/users/me/avatar` accepts an authenticated human user's request:

```json
{ "avatarSeed": "639d12a3-0ee3-4561-8f8d-80c6f9c3b5bc" }
```

Only `avatarSeed` is accepted. The server derives user and tenant from verified authentication, updates only that active account's seed and returns:

```json
{ "success": true, "data": { "user": { "uuid": "user-uuid", "avatarSeed": "639d12a3-0ee3-4561-8f8d-80c6f9c3b5bc" } } }
```

All requests require an `Origin` equal to the configured `NEXTAUTH_URL` origin, or the request URL origin when that setting is absent. Reverse-proxy deployments must configure `NEXTAUTH_URL` to the browser-facing origin. This rule also applies to Bearer requests and prevents invalid Bearer headers from bypassing checks when authentication falls back to a cookie. No cross-origin CORS allowance is provided.

Responses: 400 invalid JSON/UUID or extra properties; 401 absent/invalid authentication; 403 nonhuman authentication or missing/untrusted Origin; 404 no matching active tenant user. Failed validation never writes. Saving the same seed again is idempotent.

`GET /api/session` and `GET /api/auth/me` expose the persisted `user.avatarSeed`. The seed is display metadata, not a credential. Account UUIDs, credentials and session versions are not changed by this endpoint.
