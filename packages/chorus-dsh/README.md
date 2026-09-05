# @chorus-aidlc/chorus-dsh

Native DeepSeek Harness bundle for Chorus MCP access, lifecycle automation, prompt behavior, and the 14 Chorus AI-DLC skills.

## Install

DeepSeek Harness `0.1.2-rc.1` and pnpm are required. Add the bundle to a profile (`-w` is required — a dsh profile is a pnpm workspace root):

```sh
export CHORUS_URL="https://chorus.example.com"
export CHORUS_API_KEY="cho_..."
dsh plugin --profile web add @chorus-aidlc/chorus-dsh -w
```

The profile's dsh base installation supplies the four peer plugins declared by this package. Chorus writes no package/skill/preset/instruction files beneath `$DSH_HOME`; the sole exception is credentials — `chorus agents add` writes `$DSH_HOME/.env` (see below).

Then provision your Chorus credentials with `chorus agents add`:

```sh
chorus agents add --agents dsh --dsh-profile <name>
```

`chorus agents add` validates your key and seeds `CHORUS_URL` / `CHORUS_API_KEY` into `~/.chorus/daemon.json` (mode 0600). For a `dsh` agent it ALSO writes the same pair into `$DSH_HOME/.env` (default `~/.dsh/.env`, mode 0600, preserving any unrelated lines) — dsh's own credential channel. The OpenSpec document-mirror wrapper prefers the `chorus mcp` CLI (which reads the daemon.json credentials); where the CLI is unavailable (e.g. the `npx` init path, which does not persist `chorus` on `PATH`) it reads `CHORUS_URL` / `CHORUS_API_KEY` from that `$DSH_HOME/.env` — dsh scrubs credential-shaped variables from tool subprocesses, so the shell is not a reliable source. This `$DSH_HOME/.env` write restores what the now-retired `dsh-credentials.sh` bootstrap used to do (that script is now a stub that redirects to `chorus agents add`). The Chorus daemon injects per-agent credentials separately.

## Configuration

The `chorus-dsh-lifecycle` row accepts optional `url` and `apiKey` values. Non-empty explicit values win independently; omitted values fall back to `CHORUS_URL` and `CHORUS_API_KEY`. Credentials must not be committed to profile patches.

The bundle contains the lifecycle runtime, `cordis.patch.yml`, and the complete package-local `skills/` tree. It does not install a named agent preset or copy files into dsh-owned directories.
