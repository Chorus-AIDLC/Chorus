import type { ChorusMcpClient } from "./mcp-client.js";
import type { SseNotificationEvent } from "./sse-listener.js";

/**
 * Wake callback injected by the entry. Runs an embedded agent turn on the main
 * agent's session with `message` as the prompt (see `wake.ts` → createWake,
 * which calls `api.runtime.agent.runEmbeddedAgent`).
 *
 * `contextKey` identifies the originating Chorus action+entity (e.g.
 * `chorus:mentioned:<uuid>`); it is used for the run id / logging. The wake
 * resolves the main agent session + model and DROPS (logs + returns) when it
 * cannot run — it never throws, so the SSE service stays alive.
 */
export type ChorusWakeFn = (message: string, contextKey: string) => void;

export interface ChorusEventRouterOptions {
  mcpClient: ChorusMcpClient;
  wake: ChorusWakeFn;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * Notification detail returned from chorus_get_notifications.
 * Only the fields we need for routing.
 */
interface NotificationDetail {
  uuid: string;
  projectUuid: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  action: string;
  message: string;
  actorType: string;
  actorUuid: string;
  actorName: string;
}

export class ChorusEventRouter {
  private readonly mcpClient: ChorusMcpClient;
  private readonly wake: ChorusWakeFn;
  private readonly logger: ChorusEventRouterOptions["logger"];

  constructor(opts: ChorusEventRouterOptions) {
    this.mcpClient = opts.mcpClient;
    this.wake = opts.wake;
    this.logger = opts.logger;
  }

  /**
   * Route an incoming SSE notification event to the appropriate handler.
   * Never throws — all errors are caught and logged internally.
   */
  dispatch(event: SseNotificationEvent): void {
    // Only handle new_notification events (ignore count_update, etc.)
    if (event.type !== "new_notification") {
      this.logger.info(`SSE event type "${event.type}" ignored`);
      return;
    }

    if (!event.notificationUuid) {
      this.logger.warn("new_notification event missing notificationUuid, skipping");
      return;
    }

    // Fetch full notification details and route asynchronously
    this.fetchAndRoute(event.notificationUuid).catch((err) => {
      this.logger.error(`Failed to fetch/route notification ${event.notificationUuid}: ${err}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Build the dedupe contextKey for a notification. Identical action+entity
   * bursts collapse to the same key so OpenClaw's queue suppresses the
   * duplicate wake.
   */
  private contextKeyFor(action: string, entityUuid: string): string {
    return `chorus:${action}:${entityUuid}`;
  }

  private async fetchAndRoute(notificationUuid: string): Promise<void> {
    // Fetch notification details via MCP — use autoMarkRead=false so we don't
    // consume all unread notifications, and status=unread since we just received it
    const result = await this.mcpClient.callTool("chorus_get_notifications", {
      status: "unread",
      limit: 50,
      autoMarkRead: false,
    }) as { notifications?: NotificationDetail[] } | null;

    const notifications = result?.notifications;
    if (!notifications || !Array.isArray(notifications)) {
      this.logger.warn(`Could not fetch notifications list`);
      return;
    }

    const notification = notifications.find((n) => n.uuid === notificationUuid);
    if (!notification) {
      this.logger.warn(`Notification ${notificationUuid} not found in unread list`);
      return;
    }

    // Route based on action (which corresponds to notificationType)
    try {
      switch (notification.action) {
        case "task_assigned":
          this.handleTaskAssigned(notification);
          break;
        case "mentioned":
          this.handleMentioned(notification);
          break;
        case "elaboration_requested":
          this.handleElaborationRequested(notification);
          break;
        case "elaboration_answered":
          this.handleElaborationAnswered(notification);
          break;
        case "proposal_rejected":
          this.handleProposalRejected(notification);
          break;
        case "proposal_approved":
          this.handleProposalApproved(notification);
          break;
        case "idea_claimed":
          this.handleIdeaClaimed(notification);
          break;
        case "task_verified":
          this.handleTaskVerified(notification);
          break;
        case "task_reopened":
          this.handleTaskReopened(notification);
          break;
        default:
          this.logger.info(`Unhandled notification action: "${notification.action}"`);
          break;
      }
    } catch (err) {
      this.logger.error(`Error handling ${notification.action} notification: ${err}`);
    }
  }

  /**
   * Build @mention guidance for agent messages.
   * Instructs the agent to @mention the actor after completing work.
   */
  private buildMentionGuidance(n: NotificationDetail, entityType: string): string {
    return (
      `After completing your work, post a comment on this ${entityType} using chorus_add_comment with @mention:\n` +
      `Use this exact mention format: @[${n.actorName}](${n.actorType}:${n.actorUuid})`
    );
  }

  private handleTaskAssigned(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "task");

    this.wake(
      `[Chorus] Task assigned: ${n.entityTitle}. Task UUID: ${n.entityUuid}, Project UUID: ${n.projectUuid}. Use chorus_get_task to review the task, then chorus_claim_task to start work.\n${mentionGuidance}`,
      this.contextKeyFor("task_assigned", n.entityUuid)
    );
  }

  private handleMentioned(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, n.entityType);

    this.wake(
      `[Chorus] You were @mentioned in ${n.entityType} '${n.entityTitle}' (entityType: ${n.entityType}, entityUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}): ${n.message}\n` +
      `Review the ${n.entityType} content and use chorus_get_comments (targetType: "${n.entityType}", targetUuid: "${n.entityUuid}") to see the full conversation, then respond.\n` +
      mentionGuidance,
      this.contextKeyFor("mentioned", n.entityUuid)
    );
  }

  private handleElaborationRequested(n: NotificationDetail): void {
    this.wake(
      `[Chorus] Elaboration requested for idea '${n.entityTitle}' (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Use chorus_get_elaboration to review questions.`,
      this.contextKeyFor("elaboration_requested", n.entityUuid)
    );
  }

  private handleProposalRejected(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "proposal");

    this.wake(
      `[Chorus] Proposal '${n.entityTitle}' was REJECTED (proposalUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Review note: "${n.message}". ` +
      `Use chorus_get_proposal to review the proposal, then fix issues with chorus_update_task_draft / chorus_update_document_draft. ` +
      `After fixing, call chorus_validate_proposal then chorus_submit_proposal to resubmit.\n` +
      mentionGuidance,
      this.contextKeyFor("proposal_rejected", n.entityUuid)
    );
  }

  private handleProposalApproved(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "proposal");

    const reviewInfo = n.message.includes("Note: ") ? ` Review note: "${n.message.split("Note: ").pop()}"` : "";
    this.wake(
      `[Chorus] Proposal '${n.entityTitle}' was APPROVED (proposalUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid})!${reviewInfo} Documents and tasks have been created. ` +
      `Use chorus_get_available_tasks with projectUuid: "${n.projectUuid}" to see the new tasks ready for work.\n` +
      mentionGuidance,
      this.contextKeyFor("proposal_approved", n.entityUuid)
    );
  }

  private handleIdeaClaimed(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "idea");

    this.wake(
      `[Chorus] Idea '${n.entityTitle}' has been assigned to you (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Use chorus_get_idea to review the idea, then chorus_claim_idea to start elaboration.\n` +
      mentionGuidance,
      this.contextKeyFor("idea_claimed", n.entityUuid)
    );
  }

  private handleTaskVerified(n: NotificationDetail): void {
    this.wake(
      `[Chorus] Task '${n.entityTitle}' has been verified and is now done (taskUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Check if this unblocks other tasks: use chorus_get_unblocked_tasks with projectUuid "${n.projectUuid}" to find tasks that are now ready to start.`,
      this.contextKeyFor("task_verified", n.entityUuid)
    );
  }

  private handleTaskReopened(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "task");

    this.wake(
      `[Chorus] Task '${n.entityTitle}' has been reopened and needs rework (taskUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Use chorus_get_task to review the task and chorus_get_comments to see verification feedback, then fix the issues.\n${mentionGuidance}`,
      this.contextKeyFor("task_reopened", n.entityUuid)
    );
  }

  private handleElaborationAnswered(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "idea");

    this.wake(
      `[Chorus] Elaboration answers submitted for idea '${n.entityTitle}' (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Review the answers with chorus_get_elaboration, then either:\n` +
      `- Call chorus_validate_elaboration with empty issues [] to resolve and proceed to proposal creation\n` +
      `- Call chorus_validate_elaboration with issues + followUpQuestions for another round\n\n` +
      `After reviewing, @mention the answerer to ask if they have any further questions before you proceed.\n` +
      mentionGuidance,
      this.contextKeyFor("elaboration_answered", n.entityUuid)
    );
  }
}
