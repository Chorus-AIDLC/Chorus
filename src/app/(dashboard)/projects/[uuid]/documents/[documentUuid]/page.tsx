// src/app/(dashboard)/projects/[uuid]/documents/[documentUuid]/page.tsx
// Server Component - UUID obtained from URL

import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, FileEdit, Palette, BookOpen, FileText, ChevronRight, type LucideIcon } from "lucide-react";
import { getServerAuthContext } from "@/lib/auth-server";
import { getDocument } from "@/services/document.service";
import { projectExists } from "@/services/project.service";
import { DocumentActions } from "./document-actions";
import { DocumentContent } from "./document-content";
import { DocumentComments } from "./document-comments";

const docTypeConfig: Record<string, { labelKey: string; color: string; icon: LucideIcon }> = {
  prd: { labelKey: "documents.typePrd", color: "bg-[#E3F2FD] text-[#1976D2]", icon: ClipboardList },
  spec: { labelKey: "documents.typeSpec", color: "bg-[#E8F5E9] text-[#5A9E6F]", icon: FileEdit },
  design: { labelKey: "documents.typeDesign", color: "bg-[#F3E5F5] text-[#7B1FA2]", icon: Palette },
  note: { labelKey: "documents.typeNote", color: "bg-[#FFF3E0] text-[#E65100]", icon: BookOpen },
  other: { labelKey: "documents.typeOther", color: "bg-[#F5F5F5] text-[#6B6B6B]", icon: FileText },
};

interface PageProps {
  params: Promise<{ uuid: string; documentUuid: string }>;
}

export default async function DocumentDetailPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid, documentUuid } = await params;
  const t = await getTranslations();

  // Validate project exists
  const exists = await projectExists(auth.companyUuid, projectUuid);
  if (!exists) {
    redirect("/projects");
  }

  // Get Document details
  const document = await getDocument(auth.companyUuid, documentUuid);
  if (!document) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="text-[#6B6B6B]">{t("documents.documentNotFound")}</div>
        <Link href={`/projects/${projectUuid}/documents`} className="mt-4 text-[#C67A52] hover:underline">
          {t("documents.backToDocuments")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-4 md:p-8">
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2 text-sm">
        <Link href={`/projects/${projectUuid}/documents`} className="text-[#6B6B6B] hover:text-[#2C2C2C]">
          {t("nav.documents")}
        </Link>
        <ChevronRight className="h-4 w-4 text-[#9A9A9A]" />
        <span className="text-[#2C2C2C]">{document.title}</span>
      </div>

      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3 md:gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#F5F2EC] md:h-12 md:w-12">
            {(() => { const Icon = docTypeConfig[document.type]?.icon || FileText; return <Icon className="h-5 w-5 text-[#6B6B6B] md:h-6 md:w-6" />; })()}
          </div>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 md:gap-3">
              <Badge className={docTypeConfig[document.type]?.color || ""}>
                {t(docTypeConfig[document.type]?.labelKey || "documents.typeOther")}
              </Badge>
              <span className="rounded bg-[#F5F2EC] px-2 py-0.5 text-xs font-medium text-[#6B6B6B]">
                v{document.version}
              </span>
            </div>
            <h1 className="text-xl font-semibold text-[#2C2C2C] md:text-2xl">{document.title}</h1>
            <div className="mt-1 flex items-center gap-3 text-sm text-[#6B6B6B] md:mt-2">
              <span>{t("common.updated")} {new Date(document.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
        <DocumentActions
          documentUuid={documentUuid}
          projectUuid={projectUuid}
          exportDoc={{
            title: document.title,
            content: document.content ?? "",
            type: document.type,
            version: document.version,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            createdByName: document.createdBy?.name ?? "",
            projectName: document.project?.name ?? "",
          }}
        />
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-6 overflow-hidden lg:flex-row">
        {/* Main Content */}
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto">
          <DocumentContent
            documentUuid={documentUuid}
            projectUuid={projectUuid}
            initialContent={document.content || ""}
          />

          {/* Comments */}
          <Card className="border-[#E5E0D8] p-4">
            <h3 className="mb-3 text-sm font-medium text-[#6B6B6B]">{t("comments.title")}</h3>
            <DocumentComments
              documentUuid={documentUuid}
              currentUserUuid={auth.actorUuid}
            />
          </Card>
        </div>

        {/* Sidebar */}
        <div className="w-full space-y-4 lg:w-64 lg:flex-shrink-0">
          {/* Source Proposal */}
          {document.proposalUuid && (
            <Card className="border-[#E5E0D8] p-4">
              <h3 className="mb-3 text-sm font-medium text-[#6B6B6B]">{t("documents.sourceProposal")}</h3>
              <Link
                href={`/projects/${projectUuid}/proposals/${document.proposalUuid}`}
                className="flex items-center gap-2 text-sm text-[#C67A52] hover:underline"
              >
                <FileText className="h-4 w-4" />
                {t("documents.viewProposal")}
              </Link>
            </Card>
          )}

          {/* Details */}
          <Card className="border-[#E5E0D8] p-4">
            <h3 className="mb-3 text-sm font-medium text-[#6B6B6B]">{t("common.details")}</h3>
            <dl className="space-y-2">
              <div className="flex justify-between text-sm">
                <dt className="text-[#9A9A9A]">{t("common.type")}</dt>
                <dd className="font-medium text-[#2C2C2C]">
                  {t(docTypeConfig[document.type]?.labelKey || "documents.typeOther")}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-[#9A9A9A]">{t("common.version")}</dt>
                <dd className="font-medium text-[#2C2C2C]">v{document.version}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-[#9A9A9A]">{t("common.created")}</dt>
                <dd className="font-medium text-[#2C2C2C]">
                  {new Date(document.createdAt).toLocaleDateString()}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-[#9A9A9A]">{t("common.updated")}</dt>
                <dd className="font-medium text-[#2C2C2C]">
                  {new Date(document.updatedAt).toLocaleDateString()}
                </dd>
              </div>
            </dl>
          </Card>

          {/* Version History */}
          <Card className="border-[#E5E0D8] p-4">
            <h3 className="mb-3 text-sm font-medium text-[#6B6B6B]">{t("documents.versionHistory")}</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-[#2C2C2C]">v{document.version}</span>
                <span className="text-xs text-[#9A9A9A]">{t("status.current")}</span>
              </div>
              {document.version > 1 && (
                <p className="text-xs text-[#9A9A9A]">
                  {document.version - 1} {t("documents.previousVersions")}
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
