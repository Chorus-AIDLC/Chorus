---
name: pr-workflow
description: Complete workflow for submitting code changes — create branch, commit, open PR, check CI, fix failures, and merge.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.1.0"
  category: development
---

# PR Workflow

Complete workflow for taking local code changes through branch creation, PR, CI verification, failure fix, and merge.

## Prerequisites

- Code changes are already made and tested locally
- Remote `origin` is configured
- `gh` CLI is authenticated

## Steps

### 1. Pre-flight Check

```bash
git status
git diff --stat
git log --oneline -5
```

Verify before proceeding:
- Only intended files are modified
- No sensitive files (.env, credentials) staged
- No temp artifacts (screenshots, logs) left behind

### 2. Create Branch

Branch from current HEAD. Naming convention:

| Type | Prefix | Example |
|------|--------|---------|
| Bug fix | `fix/` | `fix/remove-legacy-textarea` |
| Feature | `feat/` | `feat/structured-ac-editor` |
| Refactor | `refactor/` | `refactor/service-layer` |
| Test | `test/` | `test/e2e-proposal-flow` |
| Docs | `docs/` | `docs/api-reference` |
| Chore | `chore/` | `chore/bump-deps` |

```bash
git checkout -b {prefix}{short-description}
```

### 3. Stage and Commit

Stage specific files only — never use `git add .` or `git add -A`:

```bash
git add path/to/file1 path/to/file2
```

**Note**: Next.js paths need shell escaping:
```bash
git add src/app/\(dashboard\)/projects/\[uuid\]/file.tsx
```

Commit with HEREDOC for clean multi-line messages:

```bash
git commit -m "$(cat <<'EOF'
{type}: {concise description of why, not what}

{Optional body explaining context or trade-offs}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 4. Push and Open PR

```bash
git push -u origin {branch-name}
```

```bash
gh pr create --title "{type}: {title under 70 chars}" --body "$(cat <<'EOF'
## Summary
- Change 1
- Change 2

## Changed files
| File | Change |
|------|--------|
| `path/file.ts` | What changed |

## Test plan
- [x] Automated test passed
- [ ] Manual verification needed

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### 5. Check CI

```bash
gh pr checks {pr-number}
```

- **All pass** — report to user, ready for merge
- **Any fail** — proceed to Step 6

### 6. Fix CI Failures

Get the failed logs:

```bash
gh pr checks {pr-number}                          # find failed run ID
gh run view {run-id} --log-failed 2>&1 | tail -80  # read failure details
```

Common failure types and fixes:

| Failure | Local repro | Fix |
|---------|------------|-----|
| Test assertion | `npx vitest run path/to/test.ts` | Update test expectations to match new behavior |
| Type error | `npx tsc --noEmit` | Fix types; check only your errors with `\| grep {keyword}` |
| Lint error | `pnpm lint` | Auto-fix or manual fix |
| Missing test update | `grep -r "changedField" src/**/__tests__/` | Update test fixtures/helpers using the old field |

After fixing:

```bash
git add {fixed-files}
git commit -m "$(cat <<'EOF'
fix: {what was fixed in tests/types}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

Re-check CI — repeat until green:

```bash
gh pr checks {pr-number}
```

### 7. Merge

Only when user explicitly requests. Default to squash merge:

```bash
gh pr merge {pr-number} --squash --delete-branch
git checkout main && git pull
```

## Checklist

Before opening PR:
- [ ] `npx tsc --noEmit` passes (or no new errors)
- [ ] Related tests pass locally
- [ ] No screenshots, temp files, or debug logs in working tree
- [ ] Grep test files for any changed field/function names

Before merging:
- [ ] CI is green
- [ ] User has approved the merge
