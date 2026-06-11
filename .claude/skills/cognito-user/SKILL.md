---
name: cognito-user
description: Create, list, reset, or delete Chorus login accounts in the AWS Cognito user pool backing the chorus.tonyhh.people.aws.dev deployment. Use when the user asks to "open an account", "add a user", "create a login", reset someone's password, or remove a user.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.1.0"
  category: operations
---

# Cognito User Management (chorus.tonyhh.people.aws.dev)

Manage human login accounts for the live Chorus deployment. Users log in via
Cognito OIDC; only `@amazon.com` emails are accepted (Chorus matches the email
domain to the "Amazon" company). Self-signup is disabled — an admin creates each
account here.

## Deployment constants

| Thing | Value |
|---|---|
| Region | `us-east-1` |
| Cognito User Pool | `us-east-1_w34zYdjVl` |
| App URL | https://chorus.tonyhh.people.aws.dev |
| Allowed email domain | `amazon.com` only |

## CRITICAL — AWS CLI v1 url-follow gotcha

This box runs aws-cli v1 with `cli_follow_urlparam` ON: any arg value starting
with `http(s)://` gets auto-fetched and replaced by the URL's CONTENT. Cognito
user commands don't take URLs so they're usually fine, but to be safe and
consistent, **always prefix Cognito CLI calls with the config override**:

```
AWS_CONFIG_FILE=/tmp/awscfg/config aws ...
```

If `/tmp/awscfg/config` is missing (fresh box), recreate it first:

```bash
mkdir -p /tmp/awscfg && printf '[default]\ncli_follow_urlparam = false\n' > /tmp/awscfg/config
```

## Create an account

1. Confirm the email ends in `@amazon.com`. If not, STOP and tell the user only
   amazon.com emails can log in.
2. Generate a temporary password that meets Cognito complexity (upper+lower+
   digit+symbol). Pattern used in this deployment: `Chorus@<6hex>1A`.
3. Run:

```bash
REGION=us-east-1
POOL=us-east-1_w34zYdjVl
EMAIL="<their>@amazon.com"
TMPPW="Chorus@$(openssl rand -hex 3)1A"
AWS_CONFIG_FILE=/tmp/awscfg/config aws cognito-idp admin-create-user \
  --region "$REGION" --user-pool-id "$POOL" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --temporary-password "$TMPPW" \
  --message-action SUPPRESS \
  --query 'User.UserStatus' --output text
echo "TEMP_PW=$TMPPW"
```

4. Report the email + temporary password to the user, and tell them the login
   flow: open the app URL → enter the email → redirected to Cognito → enter the
   temporary password → **forced to set a new password** on first login → lands
   in the "Amazon" workspace. The new Chorus User row is auto-provisioned on
   first successful login (no extra step needed in Chorus itself).

Notes:
- `--message-action SUPPRESS` means Cognito does NOT email the user — you hand
  them the temp password manually. To have Cognito email an invite instead,
  drop that flag (requires SES email sending to be configured on the pool;
  default Cognito email has a low daily cap).
- New users have status `FORCE_CHANGE_PASSWORD` until they complete first login.

## List accounts

```bash
AWS_CONFIG_FILE=/tmp/awscfg/config aws cognito-idp list-users \
  --region us-east-1 --user-pool-id us-east-1_w34zYdjVl \
  --query 'Users[].[Username,UserStatus]' --output table
```

## Reset someone's password

```bash
AWS_CONFIG_FILE=/tmp/awscfg/config aws cognito-idp admin-set-user-password \
  --region us-east-1 --user-pool-id us-east-1_w34zYdjVl \
  --username "<email>" --password "<NewTempPw1A@>" --no-permanent
```
`--no-permanent` forces a change on next login; use `--permanent` to set a final
password that won't require changing.

## Delete an account

```bash
AWS_CONFIG_FILE=/tmp/awscfg/config aws cognito-idp admin-delete-user \
  --region us-east-1 --user-pool-id us-east-1_w34zYdjVl --username "<email>"
```
This removes the Cognito login. The corresponding Chorus User row (and their
authored data) remains in the app DB; remove it separately via the app if needed.

## Related

Full deployment details (resource IDs, ops access via SSM, the OIDC company
config) live in the project memory note `chorus-aws-deployment`.
