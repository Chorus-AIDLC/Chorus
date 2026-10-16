// Credential tokens are issued by the server; the public domain belongs to the
// browser, which may be accessing Chorus through a CNAME or reverse proxy.
export function credentialLinkUrl(value: string, origin: string): string {
  try {
    const source = new URL(value, "https://credential.invalid");
    const target = new URL(origin);
    const token = source.searchParams.get("token");
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password ||
        source.pathname !== "/login/local/accept" || source.hash ||
        [...source.searchParams.keys()].length !== 1 || !token || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !["http:", "https:"].includes(target.protocol) || target.username || target.password) return "";
    return `${target.origin}/login/local/accept?token=${token}`;
  } catch {
    return "";
  }
}
