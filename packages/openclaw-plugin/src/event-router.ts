import type { ChorusMcpClient } from "./mcp-client.js";
import type { ChorusPluginConfig } from "./config.js";
import type { SseNotificationEvent } from "./sse-listener.js";

export interface ChorusEventRouterOptions {
  mcpClient: ChorusMcpClient;
  config: ChorusPluginConfig;
  triggerAgent: (message: string, metadata?: Record<string, unknown>) => void;
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
  private readonly config: ChorusPluginConfig;
  private readonly triggerAgent: ChorusEventRouterOptions["triggerAgent"];
  private readonly logger: ChorusEventRouterOptions["logger"];
  private readonly projectFilter: Set<string>;

  constructor(opts: ChorusEventRouterOptions) {
    this.mcpClient = opts.mcpClient;
    this.config = opts.config;
    this.triggerAgent = opts.triggerAgent;
    this.logger = opts.logger;
    this.projectFilter = new Set(opts.config.projectUuids ?? []);
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

    // Project filter: if projectUuids is configured, ignore events from other projects
    if (this.projectFilter.size > 0 && !this.projectFilter.has(notification.projectUuid)) {
      this.logger.info(
        `Notification for project ${notification.projectUuid} filtered out`
      );
      return;
    }

    // Route based on action (which corresponds to notificationType)
    try {
      switch (notification.action) {
        case "task_assigned":
          await this.handleTaskAssigned(notification);
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

  private async handleTaskAssigned(n: NotificationDetail): Promise<void> {
    const mentionGuidance = this.buildMentionGuidance(n, "task");

    if (this.config.autoStart) {
      try {
        await this.mcpClient.callTool("chorus_claim_task", { taskUuid: n.entityUuid });
        this.logger.info(`Auto-claimed task ${n.entityUuid}`);
      } catch (err) {
        this.logger.warn(`Failed to auto-claim task ${n.entityUuid}: ${err}`);
        // Still trigger agent even if claim fails — let the agent handle it
      }

      this.triggerAgent(
        `[Chorus] Task assigned: ${n.entityTitle}. Task UUID: ${n.entityUuid}, Project UUID: ${n.projectUuid}. Use chorus_get_task to see details and begin work.\n${mentionGuidance}`,
        { notificationUuid: n.uuid, action: "task_assigned", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
      );
    } else {
      this.triggerAgent(
        `[Chorus] Task assigned: ${n.entityTitle}. Task UUID: ${n.entityUuid}, Project UUID: ${n.projectUuid}. Use chorus_get_task to review when ready.\n${mentionGuidance}`,
        { notificationUuid: n.uuid, action: "task_assigned", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
      );
    }
  }

  private handleMentioned(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, n.entityType);

    this.triggerAgent(
      `[Chorus] You were @mentioned in ${n.entityType} '${n.entityTitle}' (entityType: ${n.entityType}, entityUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}): ${n.message}\n` +
      `Review the ${n.entityType} content and use chorus_get_comments (targetType: "${n.entityType}", targetUuid: "${n.entityUuid}") to see the full conversation, then respond.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "mentioned", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleElaborationRequested(n: NotificationDetail): void {
    this.triggerAgent(
      `[Chorus] Elaboration requested for idea '${n.entityTitle}' (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Use chorus_get_elaboration to review questions.`,
      { notificationUuid: n.uuid, action: "elaboration_requested", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleProposalRejected(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "proposal");

    this.triggerAgent(
      `[Chorus] Proposal '${n.entityTitle}' was REJECTED (proposalUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Review note: "${n.message}". ` +
      `Use chorus_get_proposal to review the proposal, then fix issues with chorus_update_task_draft / chorus_update_document_draft. ` +
      `After fixing, call chorus_validate_proposal then chorus_submit_proposal to resubmit.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "proposal_rejected", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleProposalApproved(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "proposal");

    const reviewInfo = n.message.includes("Note: ") ? ` Review note: "${n.message.split("Note: ").pop()}"` : "";
    this.triggerAgent(
      `[Chorus] Proposal '${n.entityTitle}' was APPROVED (proposalUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid})!${reviewInfo} Documents and tasks have been created. ` +
      `Use chorus_get_available_tasks with projectUuid: "${n.projectUuid}" to see the new tasks ready for work.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "proposal_approved", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleIdeaClaimed(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "idea");

    this.triggerAgent(
      `[Chorus] Idea '${n.entityTitle}' has been assigned to you (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Use chorus_get_idea to review the idea, then chorus_claim_idea to start elaboration.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "idea_claimed", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleTaskVerified(n: NotificationDetail): void {
    this.triggerAgent(
      `[Chorus] Task '${n.entityTitle}' has been verified and is now done (taskUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Check if this unblocks other tasks: use chorus_get_unblocked_tasks with projectUuid "${n.projectUuid}" to find tasks that are now ready to start.`,
      { notificationUuid: n.uuid, action: "task_verified", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleTaskReopened(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "task");

    this.triggerAgent(
      `[Chorus] Task '${n.entityTitle}' has been reopened and needs rework (taskUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Use chorus_get_task to review the task and chorus_get_comments to see verification feedback, then fix the issues.\n${mentionGuidance}`,
      { notificationUuid: n.uuid, action: "task_reopened", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }

  private handleElaborationAnswered(n: NotificationDetail): void {
    const mentionGuidance = this.buildMentionGuidance(n, "idea");

    this.triggerAgent(
      `[Chorus] Elaboration answers submitted for idea '${n.entityTitle}' (ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
      `Review the answers with chorus_get_elaboration, then either:\n` +
      `- Call chorus_validate_elaboration with empty issues [] to resolve and proceed to proposal creation\n` +
      `- Call chorus_validate_elaboration with issues + followUpQuestions for another round\n\n` +
      `After reviewing, @mention the answerer to ask if they have any further questions before you proceed.\n` +
      mentionGuidance,
      { notificationUuid: n.uuid, action: "elaboration_answered", entityUuid: n.entityUuid, projectUuid: n.projectUuid }
    );
  }
}
