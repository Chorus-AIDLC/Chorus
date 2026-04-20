"use client";

// src/app/(dashboard)/projects/[uuid]/observability/tool-usage-table.tsx
// Per-tool usage breakdown for the selected agent.

import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ToolBreakdownItem } from "@/services/observability.service";

interface ToolUsageTableProps {
  tools: ToolBreakdownItem[];
  loading?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

// MCP tools have the `chorus_` prefix; everything else is a Claude Code
// native tool (Bash, Read, Edit, etc.) so we use blue for the dot indicator.
function isMcpTool(name: string): boolean {
  return name.startsWith("chorus_");
}

function displayName(name: string): string {
  return isMcpTool(name) ? name.replace(/^chorus_/, "") : name;
}

export function ToolUsageTable({ tools, loading }: ToolUsageTableProps) {
  const t = useTranslations();

  if (tools.length === 0) {
    return (
      <Card className="border-[#E5E0D8] bg-white px-5 py-8 text-center text-sm text-[#9A9A9A]">
        {t("observability.noToolData")}
      </Card>
    );
  }

  return (
    <Card
      className={`gap-0 overflow-hidden border-[#E5E0D8] bg-white p-0 ${
        loading ? "opacity-60" : ""
      }`}
    >
      <Table>
        <TableHeader>
          <TableRow className="border-[#F5F2EC] hover:bg-transparent">
            <TableHead className="h-10 px-5 text-[11px] font-semibold uppercase text-[#9A9A9A]">
              {t("observability.toolColumn")}
            </TableHead>
            <TableHead className="h-10 px-5 text-right text-[11px] font-semibold uppercase text-[#9A9A9A]">
              {t("observability.callsColumn")}
            </TableHead>
            <TableHead className="h-10 px-5 text-right text-[11px] font-semibold uppercase text-[#9A9A9A]">
              {t("observability.tokensColumn")}
            </TableHead>
            <TableHead className="h-10 px-5 text-right text-[11px] font-semibold uppercase text-[#9A9A9A]">
              {t("observability.avgMsColumn")}
            </TableHead>
            <TableHead className="h-10 px-5 text-right text-[11px] font-semibold uppercase text-[#9A9A9A]">
              {t("observability.errorsColumn")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tools.map((tool) => {
            const mcp = isMcpTool(tool.toolName);
            const avgMs =
              tool.callCount > 0
                ? Math.round(tool.totalDurationMs / tool.callCount)
                : 0;
            const tokens = tool.totalInputSize + tool.totalOutputSize;
            return (
              <TableRow
                key={tool.toolName}
                className="border-[#F5F2EC] hover:bg-[#FAF8F4]"
              >
                <TableCell className="px-5 py-2.5 text-[12px] text-[#2C2C2C]">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        mcp ? "bg-[#C67A52]" : "bg-[#1976D2]"
                      }`}
                      title={mcp ? "MCP" : "CC"}
                      aria-label={mcp ? "MCP" : "CC"}
                    />
                    <span className="truncate font-mono text-[12px]">
                      {displayName(tool.toolName)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="px-5 py-2.5 text-right text-[12px] text-[#2C2C2C]">
                  {tool.callCount.toLocaleString()}
                </TableCell>
                <TableCell className="px-5 py-2.5 text-right text-[12px] font-medium text-[#C67A52]">
                  {tokens > 0 ? formatTokens(tokens) : "—"}
                </TableCell>
                <TableCell className="px-5 py-2.5 text-right text-[12px] text-[#6B6B6B]">
                  {avgMs > 0 ? avgMs.toLocaleString() : "—"}
                </TableCell>
                <TableCell
                  className={`px-5 py-2.5 text-right text-[12px] ${
                    tool.errorCount > 0
                      ? "text-[#DC2626]"
                      : "text-[#9A9A9A]"
                  }`}
                >
                  {tool.errorCount}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
