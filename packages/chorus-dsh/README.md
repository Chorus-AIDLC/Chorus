# @chorus-aidlc/chorus-dsh

Native DeepSeek Harness bundle for Chorus MCP access, lifecycle automation, prompt behavior, and the 14 Chorus AI-DLC skills.

## Install

DeepSeek Harness `0.1.0-rc.7` and pnpm are required. Add the bundle to a profile (`-w` is required — a dsh profile is a pnpm workspace root):

```sh
export CHORUS_URL="https://chorus.example.com"
export CHORUS_API_KEY="cho_..."
dsh plugin --profile web add @chorus-aidlc/chorus-dsh -w
```

The profile's dsh base installation supplies the four peer plugins declared by this package. Chorus does not write files beneath `$DSH_HOME`.

Then store the credentials where dsh's tools can read them. dsh scrubs credential-shaped variables from tool subprocesses, so the OpenSpec document-mirror wrapper reads `CHORUS_URL` / `CHORUS_API_KEY` from `$DSH_HOME/.env` (dsh's credential fallback), not the shell:

```sh
CHORUS_URL="$CHORUS_URL" CHORUS_API_KEY="$CHORUS_API_KEY" \
  bash <(curl -fsSL "$CHORUS_URL/dsh-credentials.sh")
```

`dsh-credentials.sh` is served by the Chorus instance; it writes only `$DSH_HOME/.env` (mode 0600, preserving other entries) and copies no plugin files. The Chorus daemon injects per-agent credentials separately.

## Configuration

The `chorus-dsh-lifecycle` row accepts optional `url` and `apiKey` values. Non-empty explicit values win independently; omitted values fall back to `CHORUS_URL` and `CHORUS_API_KEY`. Credentials must not be committed to profile patches.

The bundle contains the lifecycle runtime, `cordis.patch.yml`, and the complete package-local `skills/` tree. It does not install a named agent preset or copy files into dsh-owned directories.
