import { describe, expect, it, vi } from "vitest";
import * as Persona from "@deepseek-ai/dsh-persona";
import { Config, apply } from "../src/persona.js";

describe("scoped persona controller", () => {
  it("requires inline text and pins the expected external peer name", () => {
    expect(Config({ text: "Chorus" })).toEqual({
      plugin: "@deepseek-ai/dsh-persona",
      text: "Chorus",
    });
    expect(() => Config({} as never)).toThrow();
    expect(() =>
      Config({ plugin: "@deepseek-ai/other", text: "Chorus" }),
    ).toThrow();
  });

  it("mounts dsh-persona through each agent context", () => {
    let created: ((payload: { agent: { ctx: { plugin: typeof vi.fn } } }) => void) | undefined;
    const ctx = {
      on: vi.fn((_event: string, handler: typeof created) => {
        created = handler;
      }),
    };
    const plugin = vi.fn();
    apply(ctx as never, { text: "Inline Chorus rules" });
    created?.({ agent: { ctx: { plugin } } });
    expect(plugin).toHaveBeenCalledWith(Persona, {
      text: "Inline Chorus rules",
    });
  });
});
