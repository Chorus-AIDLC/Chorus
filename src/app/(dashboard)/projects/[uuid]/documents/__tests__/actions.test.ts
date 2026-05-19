import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserAuthContext } from "@/types/auth";

const mockGetServerAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: mockGetServerAuthContext,
}));

const mockGetDocumentByUuidUnscoped = vi.hoisted(() => vi.fn());
const mockDeleteDocument = vi.hoisted(() => vi.fn());
vi.mock("@/services/document.service", () => ({
  // Other exports used by sibling actions in the same file are stubbed so the
  // module loads without pulling in prisma.
  createDocument: vi.fn(),
  getDocumentByUuidUnscoped: mockGetDocumentByUuidUnscoped,
  deleteDocument: mockDeleteDocument,
}));

vi.mock("@/services/activity.service", () => ({
  createActivity: vi.fn(),
}));

vi.mock("@/services/project.service", () => ({
  projectExists: vi.fn(),
}));

const mockRevalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/logger", () => {
  const noopLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => noopLogger),
  };
  return { default: noopLogger };
});

import { deleteDocumentAction } from "../actions";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const PROJECT_UUID = "project-1";
const DOCUMENT_UUID = "doc-1";
const DOCUMENTS_PATH = `/projects/${PROJECT_UUID}/documents`;

function humanAuth(companyUuid = COMPANY_A): UserAuthContext {
  return {
    type: "user",
    companyUuid,
    actorUuid: "user-1",
    email: "u@test.com",
  };
}

function makeDocRow(overrides: Partial<{ uuid: string; companyUuid: string; projectUuid: string }> = {}) {
  return {
    uuid: DOCUMENT_UUID,
    companyUuid: COMPANY_A,
    projectUuid: PROJECT_UUID,
    type: "prd",
    title: "Doc",
    content: null,
    version: 1,
    proposalUuid: null,
    createdByUuid: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("deleteDocumentAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unauthorized when no auth context", async () => {
    mockGetServerAuthContext.mockResolvedValue(null);

    const result = await deleteDocumentAction(DOCUMENT_UUID);

    expect(result).toEqual({ success: false, error: "unauthorized" });
    expect(mockGetDocumentByUuidUnscoped).not.toHaveBeenCalled();
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("succeeds for a human user in the same company", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetDocumentByUuidUnscoped.mockResolvedValue(makeDocRow());
    mockDeleteDocument.mockResolvedValue(undefined);

    const result = await deleteDocumentAction(DOCUMENT_UUID);

    expect(result).toEqual({ success: true, projectUuid: PROJECT_UUID });
    expect(mockGetDocumentByUuidUnscoped).toHaveBeenCalledWith(DOCUMENT_UUID);
    expect(mockDeleteDocument).toHaveBeenCalledWith(DOCUMENT_UUID);
    expect(mockRevalidatePath).toHaveBeenCalledWith(DOCUMENTS_PATH);
  });

  it("returns not_found when the document does not exist", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetDocumentByUuidUnscoped.mockResolvedValue(null);

    const result = await deleteDocumentAction(DOCUMENT_UUID);

    expect(result).toEqual({ success: false, error: "not_found" });
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns forbidden for cross-company access and never calls deleteDocument", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth(COMPANY_A));
    mockGetDocumentByUuidUnscoped.mockResolvedValue(
      makeDocRow({ companyUuid: COMPANY_B }),
    );

    const result = await deleteDocumentAction(DOCUMENT_UUID);

    expect(result).toEqual({ success: false, error: "forbidden" });
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns the underlying error message when deleteDocument throws", async () => {
    mockGetServerAuthContext.mockResolvedValue(humanAuth());
    mockGetDocumentByUuidUnscoped.mockResolvedValue(makeDocRow());
    mockDeleteDocument.mockRejectedValue(new Error("DB connection lost"));

    const result = await deleteDocumentAction(DOCUMENT_UUID);

    expect(result).toEqual({ success: false, error: "DB connection lost" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
