# fix-daemon-server-signal-handler-leak

Guard the server SIGINT/SIGTERM/exit handlers behind !isSubcommand so chorus daemon shuts down via its own graceful path
