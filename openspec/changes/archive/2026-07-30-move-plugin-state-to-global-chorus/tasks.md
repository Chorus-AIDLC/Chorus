# Tasks — move-plugin-state-to-global-chorus

## 1. Shared path module
- [ ] 1.1 Add `bin/chorus-paths.sh` — global root, `chorus_slug_for_dir`, `CHORUS_STATE_DIR` resolution, `CHORUS_PLUGIN_STATE_ROOT` override, `no-session` fallback. Bash 3.2 safe.

## 2. chorus-api.sh + hook wiring
- [ ] 2.1 `chorus-api.sh` sources `chorus-paths.sh`; `STATE_DIR`/`STATE_FILE`/`SESSIONS_DIR`/MCP temp files resolve from it.
- [ ] 2.2 Every STATE_DIR-touching hook extracts `session_id` from stdin and exports `CHORUS_SESSION_ID`; sub-path builders (`pending/`/`claimed/`/`sessions/`) source `chorus-paths.sh`. Set = on-session-start, on-user-prompt, on-pre-spawn-agent, on-subagent-start, on-subagent-stop, **on-teammate-idle, on-task-completed, on-post-verify-task**. Verify the three bolded cross-hook/temp-file hooks resolve to the same partition as the writer.

## 3. Cleanup
- [ ] 3.1 `on-session-end.sh` removes only the current session dir (guard against wiping the `no-session` bucket); best-effort `rmdir` empty parent.

## 4. Tests
- [ ] 4.1 Extend `bin/test-syntax.sh` — assert global placement, slug encoding, `no-session` fallback; passes under Bash 3.2.

## 5. Docs
- [ ] 5.1 Update `docs/chorus-plugin.md` + the two plugin blog posts to the global layout.
