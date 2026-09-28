/** Reference identity comes only from a complete Markdown link destination. */
export function referenceUuid(href: string | undefined): string | null {
  return /^ref:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    .exec(href ?? "")?.[1].toLowerCase() ?? null;
}

export function safeReferenceUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
