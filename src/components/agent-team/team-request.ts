import { authFetch } from "@/lib/auth-client";

export async function teamRequest<Result>(url: string, init?: RequestInit): Promise<Result> {
  const response = await authFetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok || !body.success) throw body.error ?? {};
  return body.data;
}

export function teamErrorKey(error: unknown) {
  const code = (error as { code?: string })?.code;
  return code === "CONFLICT" ? "stale" : code === "VALIDATION_ERROR" ? "invalid" : code === "FORBIDDEN" ? "denied" : "failed";
}
