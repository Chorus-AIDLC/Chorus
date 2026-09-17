export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Startup security check (GitHub issue #559): logs only, never throws,
    // never sets a fallback secret. Must run before any service is loaded.
    const { warnOnInsecureNextAuthSecret } = await import("./lib/secret-check");
    warnOnInsecureNextAuthSecret();
    await import("./services/notification-listener");
  }
}
