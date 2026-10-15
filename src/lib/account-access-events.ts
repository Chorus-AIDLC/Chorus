import { eventBus } from "@/lib/event-bus";
import logger from "@/lib/logger";

export interface AccountAccessChangedEvent {
  companyUuid: string;
  userUuid?: string;
  agentUuid?: string;
  keyUuid?: string;
}

// Call only after persistence commits. Broadcast is best-effort; stream leases
// provide the bounded fallback, so a transport error cannot undo a committed edit.
export function publishAccountAccessChanged(event: AccountAccessChangedEvent) {
  try { eventBus.emit("account_access_changed", event); }
  catch (err) { logger.error({ err }, "Account access-change broadcast failed"); }
}
