"use client";

import { formatDateTime } from "@/lib/format-date";

export function FormattedDateTime({ date }: { date: string | Date }) {
  return <>{formatDateTime(date)}</>;
}
