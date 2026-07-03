# fix-daemon-stale-pid-identity

Identity-verify daemon pidfile liveness so a reboot-recycled PID (EPERM) is treated as stale, with self-heal and stop --force
