import { describe, expect, it } from "vitest";
import {
  appendReplyMention,
  findReplyMentionable,
  resolveMentionSelection,
  type MentionPin,
} from "@/components/mention-editor";
import { buildMentionMarker } from "@/lib/mention-format";

const USER_UUID = "11111111-1111-4111-8111-111111111111";
const AGENT_UUID = "22222222-2222-4222-8222-222222222222";

describe("MentionEditor programmatic reply insertion", () => {
  it("preserves the draft and appends a structured human mention at a text boundary", () => {
    const result = appendReplyMention("Existing draft", {
      type: "user",
      uuid: USER_UUID,
      name: "Alice",
    });

    expect(result).toEqual({
      value: `Existing draft ${buildMentionMarker("Alice", "user", USER_UUID)} `,
      appended: true,
    });
  });

  it("does not duplicate an adjacent mention with the same stable identity", () => {
    const existing = `Draft ${buildMentionMarker(
      "Old name",
      "agent",
      AGENT_UUID,
      "offline-host",
      "/old/repo",
    )} `;

    expect(
      appendReplyMention(existing, {
        type: "agent",
        uuid: AGENT_UUID,
        name: "Renamed agent",
      }),
    ).toEqual({ value: existing, appended: false });
  });

  it("serializes the exact project-fixed runtime pin selected by the shared resolver", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: AGENT_UUID,
      name: "Builder",
      projectFixedCwd: {
        host: "build-host",
        cwd: "/srv/project",
        availability: "offline",
      },
      instances: [
        {
          connectionUuid: "connection-other",
          agentInstanceUuid: "instance-other",
          host: "other-host",
          cwd: "/other",
          effectiveStatus: "online",
        },
      ],
    });

    expect(decision.kind).toBe("insert");
    const pin =
      decision.kind === "insert" ? decision.pin : null;
    const result = appendReplyMention(
      "",
      { type: "agent", uuid: AGENT_UUID, name: "Builder" },
      pin as MentionPin,
    );

    expect(result.value).toBe(
      `${buildMentionMarker(
        "Builder",
        "agent",
        AGENT_UUID,
        "build-host",
        "/srv/project",
        true,
      )} `,
    );
  });

  it("selects Agent routing data by stable type and UUID rather than display name", () => {
    expect(
      findReplyMentionable(
        { type: "agent", uuid: AGENT_UUID, name: "Renamed builder" },
        [
          { type: "user", uuid: USER_UUID, name: "Renamed builder" },
          {
            type: "agent",
            uuid: AGENT_UUID,
            name: "Original builder",
            instances: [],
          },
        ],
      ),
    ).toMatchObject({
      type: "agent",
      uuid: AGENT_UUID,
      name: "Original builder",
    });
  });

  it("fails instead of inserting an unpinned Agent mention when routing data is unavailable", () => {
    expect(() =>
      findReplyMentionable(
        { type: "agent", uuid: AGENT_UUID, name: "Builder" },
        [{ type: "user", uuid: USER_UUID, name: "Builder" }],
      ),
    ).toThrow("Reply author is unavailable for mention routing");
  });
});
