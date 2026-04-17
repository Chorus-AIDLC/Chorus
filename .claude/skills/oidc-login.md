# OIDC Login Test Skill

Use this skill to automatically log in via OIDC for testing purposes.

## Instructions

1. Read credentials from `.testdata/credentials.json`
2. Use Playwright MCP to automate the login flow:
   - Navigate to http://localhost:3000/login
   - Enter the email address
   - Click continue to trigger OIDC redirect
   - On Cognito login page, enter email and password
   - Complete the login flow
3. Verify login success by checking redirect to /projects

## Credential File Location

```
.testdata/credentials.json
```

Format:
```json
{
  "oidc": {
    "email": "user@example.com",
    "password": "password"
  }
}
```

## Playwright Steps

```
1. browser_navigate to http://localhost:3000/login
2. browser_fill_form for email input
3. browser_click on continue button
4. Wait for Cognito redirect
5. browser_fill_form for Cognito email/password
6. browser_click on sign in button
7. Wait for callback and redirect to /projects
8. Verify success
```
