// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TeamMemberChip, TeamRoleRow, TeamStatusBadge, roleIcons, type TeamRoleRowProps } from "@/components/agent-team";

vi.mock("@/components/ui/agent-avatar", () => ({ AgentAvatar: () => <span data-testid="avatar" /> }));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(cleanup);

const member = { uuid: "agent-1", name: "Leo" };

function rowProps(overrides: Partial<TeamRoleRowProps> = {}): TeamRoleRowProps {
  return {
    role: "development",
    roleLabel: "Development",
    description: "Execute tasks",
    members: [member],
    addLabel: "Add development agent",
    emptyLabel: "No agents available",
    actionsLabel: "Development actions",
    removeLabel: (entry) => `Remove ${entry.name}`,
    addOptions: [{ uuid: "agent-2", name: "Tom" }, { uuid: "agent-3", name: "Unavailable", disabled: true }],
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    actions: <DropdownMenuItem>Clear role</DropdownMenuItem>,
    ...overrides,
  };
}

describe("TeamMemberChip", () => {
  it("renders an avatar and invokes remove with the member UUID", async () => {
    const onRemove = vi.fn();
    render(<TeamMemberChip member={member} removeLabel="Remove Leo" onRemove={onRemove} />);
    expect(screen.getByTestId("avatar")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove Leo" }));
    expect(onRemove).toHaveBeenCalledWith("agent-1");
  });

  it("exposes the warning reason before opening its keyboard-accessible tooltip", async () => {
    render(<TeamMemberChip member={{ ...member, ineligibleReason: "Missing task permission", online: false, presenceLabel: "Offline" }} removeLabel="Remove Leo" readOnly />);
    const identity = screen.getByText("Leo").parentElement!;
    expect(identity.tabIndex).toBe(0);
    expect(document.getElementById(identity.getAttribute("aria-describedby")!)?.textContent).toBe("Missing task permission");
    expect(identity.closest(".border-destructive\\/40")?.className).toContain("dark:border-destructive/60");
    expect(screen.getByText("Offline")).toBeTruthy();
    await userEvent.tab();
    expect((await screen.findByRole("tooltip")).textContent).toBe("Missing task permissionOffline");
  });

  it("opens presence and eligibility hints on tap for touch users", async () => {
    render(<TeamMemberChip member={{ ...member, online: true, presenceLabel: "Online · 1 active / queued" }} removeLabel="Remove Leo" readOnly />);
    const identity = screen.getByText("Leo").parentElement!;
    expect(identity.tabIndex).toBe(0);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.click(identity);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Online · 1 active / queued");
  });

  it("hides removal when read-only and disables it when busy", async () => {
    const onRemove = vi.fn();
    const { rerender } = render(<TeamMemberChip member={member} removeLabel="Remove Leo" onRemove={onRemove} readOnly />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<TeamMemberChip member={member} removeLabel="Remove Leo" onRemove={onRemove} disabled />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe("TeamRoleRow", () => {
  it("adds through AgentSelect and closes the popover", async () => {
    const props = rowProps();
    render(<TeamRoleRow {...props} />);
    await userEvent.click(screen.getByRole("button", { name: props.addLabel }));
    await userEvent.click(screen.getByRole("combobox", { name: props.addLabel }));
    expect(screen.getByRole("option", { name: "Unavailable" }).getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(screen.getByRole("option", { name: "Tom" }));
    expect(props.onAdd).toHaveBeenCalledWith("agent-2");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("renders the action slot in the menu and forwards removal", async () => {
    const onClear = vi.fn();
    const props = rowProps({ actions: <DropdownMenuItem onSelect={onClear}>Clear role</DropdownMenuItem> });
    render(<TeamRoleRow {...props} badge={<TeamStatusBadge status="inherited" label="Inherited" />} />);
    expect(screen.getByRole("group", { name: "Development" })).toBeTruthy();
    expect(screen.getByText("Inherited")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove Leo" }));
    expect(props.onRemove).toHaveBeenCalledWith("agent-1");
    await userEvent.click(screen.getByRole("button", { name: props.actionsLabel }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Clear role" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("hides all editing controls in readOnly mode", () => {
    render(<TeamRoleRow {...rowProps({ readOnly: true })} />);
    expect(screen.getByText("Leo")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("disables all controls and closes an open menu while disabled", async () => {
    const props = rowProps();
    const { rerender } = render(<TeamRoleRow {...props} />);
    await userEvent.click(screen.getByRole("button", { name: props.actionsLabel }));
    expect(screen.getByRole("menuitem")).toBeTruthy();
    rerender(<TeamRoleRow {...props} disabled />);
    expect(screen.queryByRole("menuitem")).toBeNull();
    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      await userEvent.click(button);
    }
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows empty candidate feedback and closes an open add control when readOnly", async () => {
    const props = rowProps({ addOptions: [] });
    const { rerender } = render(<TeamRoleRow {...props} />);
    await userEvent.click(screen.getByRole("button", { name: props.addLabel }));
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByText(props.emptyLabel)).toBeTruthy();
    rerender(<TeamRoleRow {...props} readOnly />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("TeamStatusBadge and icons", () => {
  it("exports all four role icons", () => {
    expect(Object.keys(roleIcons)).toEqual(["product", "development", "review", "lead"]);
  });

  it.each(["inherited", "overridden", "snapshot"] as const)("renders a localized %s badge", (status) => {
    render(<TeamStatusBadge status={status} label={`Localized ${status}`} />);
    const badge = screen.getByText(`Localized ${status}`);
    if (status === "overridden") expect(badge.className).toContain("text-primary");
    if (status === "snapshot") expect(badge.className).toContain("text-muted-foreground");
    if (status === "inherited") expect(badge.className).toContain("bg-secondary");
  });
});
