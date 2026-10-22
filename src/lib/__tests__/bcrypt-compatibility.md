# Legacy bcrypt compatibility fixtures

`bcrypt-compatibility.fixture.ts` contains fixed hashes generated with
`bcryptjs@2.4.3`, not with the library under test. Local credentials use cost 12;
the Super Admin environment credential uses cost 10. `localUtf8Boundary` is
exactly 72 UTF-8 bytes (24 Chinese characters).

Reproduce independently in a temporary directory without changing the repository's
dependencies:

```sh
fixture_dir=$(mktemp -d)
(
  cd "$fixture_dir" || exit 1
  npm init -y >/dev/null
  npm install --ignore-scripts --save-exact bcryptjs@2.4.3
  node <<'NODE'
const bcrypt = require("bcryptjs");
console.log("generator:", require("bcryptjs/package.json").version);
const fixtures = {
  localAscii: ["a-valid-password-123", "$2a$12$abcdefghijklmnopqrstuu"],
  localUtf8Boundary: ["密".repeat(24), "$2a$12$abcdefghijklmnopqrstuu"],
  superAdmin: ["legacy-admin-password-123", "$2a$10$abcdefghijklmnopqrstuu"],
};
for (const [name, [password, salt]] of Object.entries(fixtures)) {
  console.log(name, Buffer.byteLength(password, "utf8"), bcrypt.hashSync(password, salt));
}
NODE
)
```

The fixed salts are only for reproducible test data, never production credentials.
Tests retain dynamic current-library hashes separately and verify legacy hashes
through the real credential service, login route, and Super Admin verifier.
