import { Code2, Compass, Lightbulb, ShieldCheck, type LucideIcon } from "lucide-react";
import type { AgentTeamRole } from "@/types/agent-team";

export const roleIcons: Record<AgentTeamRole, LucideIcon> = {
  product: Lightbulb,
  development: Code2,
  review: ShieldCheck,
  lead: Compass,
};
