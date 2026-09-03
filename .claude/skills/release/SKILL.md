---
name: release
description: Release a new version of Chorus — bump version, update CHANGELOG, commit, tag, and create GitHub release.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.1.0"
  category: development
---

# Chorus Release Process

Step-by-step guide to cut a new release of Chorus.

## Prerequisites

- `gh` CLI is authenticated (`gh auth status`)
- Working tree is clean (`git status`)
- You are on the `develop` branch

## Steps

### 1. Fetch remote and identify the diff since last release

```bash
# Fetch remote tags and branches so local refs are up to date
git fetch --tags origin

# Find the previous release tag
git tag -l 'v*' --sort=-version:refname | head -5

# List commits since previous tag on develop
git log --oneline v<PREV>..develop

# Review each commit for CHANGELOG-worthy changes
git show --stat <commit-hash>
```

### 2. Draft CHANGELOG and get user approval

Based on the commits identified in Step 1, draft the new CHANGELOG section and **present it to the user for review**. Use this structure:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- **Feature name**: Description of what was added.

### Changed
- **Area**: Description of what changed.

### Fixed
- **Bug name**: Description of what was fixed.

### Plugin
- Plugin version changes if applicable.

---
```

**Rules:**
- Only include commits **after** the previous release tag
- Group by Added / Changed / Fixed / Deprecated / Removed / Plugin
- Omit empty groups
- Each entry should start with a **bold label** followed by a concise description
- Separate from the previous release section with `---`

**IMPORTANT:** After drafting, show the CHANGELOG content and the proposed version number to the user. **Do NOT proceed** until the user explicitly approves. The user may request edits to wording, version number, or grouping.

### 3. Write CHANGELOG.md (on develop)

After user approval, write the approved content into `CHANGELOG.md` — add the new section at the top, below the `# Changelog` header and above the previous release section.

### 4. Bump all four npm package versions (on develop)

```bash
# Keep the coordinated release identity in lockstep:
# package.json
# packages/openclaw-plugin/package.json
# packages/chorus-dsh/package.json
# packages/chorus-pi/package.json

# Refresh OpenClaw's standalone lockfile after editing its package version:
cd packages/openclaw-plugin
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
cd ../..
```

The GitHub Release tag, root Chorus CLI, OpenClaw plugin, dsh plugin, and
chorus-pi plugin MUST all use the same `X.Y.Z`. The coordinated publication
preflight rejects any name or version drift before an npm registry write.

`packages/chorus-pi` publishes its TypeScript as-is and has **no** standalone
lockfile of its own (it rides the workspace `pnpm-lock.yaml`), so — unlike
OpenClaw — bumping its `package.json` version needs no lockfile refresh. If you
also changed chorus-pi's dependencies, run `pnpm install --lockfile-only` at the
repo root so the workspace lockfile stays in sync (the release preflight runs
`pnpm install --frozen-lockfile` and fails on drift).

Follow [semver](https://semver.org/):
- **patch** (0.1.0 → 0.1.1): bug fixes, minor additions
- **minor** (0.1.0 → 0.2.0): new features, non-breaking changes
- **major** (0.1.0 → 1.0.0): breaking changes

### 5. Commit to develop and open PR to main

```bash
# Commit the release prep on develop
git add CHANGELOG.md package.json \
  packages/openclaw-plugin/package.json \
  packages/openclaw-plugin/package-lock.json \
  packages/chorus-dsh/package.json \
  packages/chorus-pi/package.json
git commit -m "chore: bump version to vX.Y.Z and update CHANGELOG"
git push origin develop

# Open a PR from develop → main
gh pr create --base main --head develop \
  --title "chore: release vX.Y.Z" \
  --body "Release vX.Y.Z — version bump and CHANGELOG update."
```

Wait for CI to pass, then merge the PR:

```bash
# Merge the PR (use the PR number returned above)
gh pr merge <PR_NUMBER> --merge
```

### 6. Create GitHub release with tag (on main)

After the PR is merged into `main`:

```bash
# Fetch the latest main so the tag targets the correct commit
git fetch origin main

gh release create vX.Y.Z \
  --target main \
  --title "vX.Y.Z" \
  --notes "$(cat <<'EOF'
<paste only the new version's CHANGELOG section here, without the ## header>
EOF
)"
```

**Important:** The `--notes` should contain **only** the new version's content, not the entire CHANGELOG file.

Publishing the GitHub Release triggers
`.github/workflows/publish-npm.yml`. That workflow prepares and validates all
four tarballs before publishing, then publishes Chorus CLI → OpenClaw → dsh →
chorus-pi through npm Trusted Publishing/OIDC. Do not run the legacy interactive
publish scripts as an additional release step.

### 6.1 Trusted Publisher contract and recovery

Each npm package's Trusted Publisher settings must match:

- repository owner/name: the GitHub repository that contains this workflow;
- workflow filename: `publish-npm.yml` (exact filename);
- Environment: blank when the workflow has no `environment`, or the exact same
  Environment name on both npm and the `publish` job.

The workflow file path is `.github/workflows/publish-npm.yml`; npm's Trusted
Publisher form takes the filename, not the full path. The job runs on a
GitHub-hosted runner with `id-token: write`, does not use `NPM_TOKEN` or
`NODE_AUTH_TOKEN`, and leaves provenance enabled. Public-repository publishes
must expose an SLSA provenance attestation after upload.

**New package — one-time ops step for `@chorus-aidlc/chorus-pi`.** chorus-pi is
the 4th coordinated package and was added after the first three. Before its
first coordinated publish, a maintainer with npm publish rights MUST register
its Trusted Publisher on npmjs.org (`Settings → Publishing access → Trusted
Publisher`): same GitHub repository owner/name, workflow filename
`publish-npm.yml`, and a blank Environment (matching the other three). This is a
human/npm-console action that cannot be scripted from this repo — until it is
done, the OIDC publish step for chorus-pi will be rejected and the run will stop
at chorus-pi with the earlier three already published (a partial-publish state;
recover via **Re-run jobs** once the Trusted Publisher is registered). Do not
create a placeholder token or disable provenance to work around it.

If a run partially publishes the fixed sequence, fix the external failure and
use **Re-run jobs** on the same failed GitHub Actions run. Do not create another
tag or GitHub Release and do not bump the version. The rerun queries every exact
`name@version`, records existing versions as `skipped-already-published`, and
continues with the first missing package. Registry lookup errors remain fatal;
never assume an ambiguous lookup means “not published.”

### 7. Sync develop with main and verify

```bash
# Pull the merge commit back into develop
git checkout develop
git pull origin develop

# Confirm tag exists
git tag -l 'vX.Y.Z'

# Confirm release is visible
gh release view vX.Y.Z
```

## Checklist

- [ ] `git fetch --tags origin` run — local tags are up to date
- [ ] `git log v<PREV>..develop` reviewed — no commits missed
- [ ] CHANGELOG draft presented to user and **approved**
- [ ] CHANGELOG.md written with approved content
- [ ] Root, OpenClaw, dsh, and chorus-pi package versions are the same `X.Y.Z`
- [ ] OpenClaw `package-lock.json` refreshed for `X.Y.Z` (chorus-pi needs no lockfile refresh)
- [ ] Changes committed and pushed to `develop`
- [ ] PR from `develop` → `main` created, CI passed, and merged
- [ ] `gh release create` with tag targeting `main`
- [ ] `@chorus-aidlc/chorus-pi` Trusted Publisher registered on npmjs.org (one-time, before its first coordinated publish)
- [ ] `publish-npm.yml` run passed for all four packages (published or safely skipped)
- [ ] Public-package provenance attestations were verified by the workflow
- [ ] Release notes contain only the new version's section
- [ ] `develop` synced with `main` after merge
- [ ] `gh release view` confirms everything looks correct
