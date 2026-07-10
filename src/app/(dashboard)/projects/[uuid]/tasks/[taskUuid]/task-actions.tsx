"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { AssignModal } from "@/components/assign-modal";
import { UserPlus, CheckCircle, Loader2 } from "lucide-react";
import { claimTaskAction, claimTaskToAgentAction, claimTaskToUserAction, verifyTaskAction, getDeveloperAgentsAction } from "./actions";

interface Agent {
  uuid: string;
  name: string;
  roles: string[];
  ownerUuid?: string | null;
}

interface CompanyUser {
  uuid: string;
  name: string | null;
  email: string | null;
}

interface TaskActionsProps {
  taskUuid: string;
  projectUuid: string;
  status: string;
  currentUserUuid?: string;
}

export function TaskActions({ taskUuid, status, currentUserUuid }: TaskActionsProps) {
  const t = useTranslations();
  const router = useRouter();
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    // Load Developer agents and users when modal opens
    if (showAssignModal) {
      getDeveloperAgentsAction().then(({ agents, users }) => {
        setAgents(agents);
        setUsers(users || []);
      });
    }
  }, [showAssignModal]);

  const handleAssignToSelf = async () => {
    return claimTaskAction(taskUuid);
  };

  const handleAssignToAgent = async (agentUuid: string) => {
    return claimTaskToAgentAction(taskUuid, agentUuid);
  };

  const handleAssignToUser = async (userUuid: string) => {
    return claimTaskToUserAction(taskUuid, userUuid);
  };

  const handleVerify = () => {
    startTransition(async () => {
      const result = await verifyTaskAction(taskUuid);
      if (result.success) {
        router.refresh();
      }
    });
  };

  return (
    <div className="flex gap-2">
      {status === "open" && (
        <>
          <Button
            onClick={() => setShowAssignModal(true)}
            className="bg-primary hover:bg-[#B56A42] text-white"
          >
            <UserPlus className="mr-2 h-4 w-4" />
            {t("common.assign")}
          </Button>
          <AssignModal
            open={showAssignModal}
            onOpenChange={setShowAssignModal}
            title={t("tasks.assignTask")}
            agents={agents}
            users={users}
            currentUserUuid={currentUserUuid}
            onAssignToSelf={handleAssignToSelf}
            onAssignToAgent={handleAssignToAgent}
            onAssignToUser={handleAssignToUser}
          />
        </>
      )}
      {status === "to_verify" && (
        <Button
          onClick={handleVerify}
          disabled={isPending}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          {isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle className="mr-2 h-4 w-4" />
          )}
          {isPending ? t("common.processing") : t("common.verify")}
        </Button>
      )}
      <Button
        variant="outline"
        className="border-border text-muted-foreground"
        onClick={() => router.back()}
      >
        {t("common.back")}
      </Button>
    </div>
  );
}
