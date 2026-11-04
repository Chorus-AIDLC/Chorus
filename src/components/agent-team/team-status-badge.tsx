import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type TeamRoleStatus = "inherited" | "overridden" | "snapshot";

export function TeamStatusBadge({ status, label }: { status: TeamRoleStatus; label: string }) {
  return (
    <Badge variant={status === "inherited" ? "secondary" : "outline"} className={cn(
      "text-[10px] font-normal",
      status === "overridden" && "border-primary/40 text-primary",
      status === "snapshot" && "text-muted-foreground",
    )}>
      {label}
    </Badge>
  );
}
