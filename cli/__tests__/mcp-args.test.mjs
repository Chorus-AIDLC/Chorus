// cli/__tests__/mcp-args.test.mjs
// Covers cli-mcp-client: parseMcpArgs (action/flag parsing) + assembleArgs
// (base sources, file/stdin string filling, override order, @@ escape, errors).
import { describe, it, expect } from "vitest";
import { parseMcpArgs, assembleArgs, mcpHelpText, UsageError } from "../mcp-args.mjs";

/** Injected IO with a fake filesystem + fixed stdin. */
function io({ files = {}, stdin = "" } = {}) {
  return {
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readStdin: () => stdin,
  };
}

describe("parseMcpArgs", () => {
  it("parses `call <tool> <json>` with the base JSON positional", () => {
    const p = parseMcpArgs(["call", "chorus_get_task", '{"taskUuid":"t1"}']);
    expect(p.action).toBe("call");
    expect(p.tool).toBe("chorus_get_task");
    expect(p.positionalJson).toBe('{"taskUuid":"t1"}');
  });

  it("records --arg / --arg-file overrides in command-line order and creds flags", () => {
    const p = parseMcpArgs([
      "call", "t",
      "--arg", "a=1",
      "--arg-file", "content=./f.md",
      "--arg", "b=@./g.md",
      "--agent", "worker-a",
      "--url", "https://c",
      "--api-key", "cho_k",
    ]);
    expect(p.overrides).toEqual([
      { type: "arg", key: "a", raw: "1" },
      { type: "arg-file", key: "content", raw: "./f.md" },
      { type: "arg", key: "b", raw: "@./g.md" },
    ]);
    expect(p.creds).toEqual({ agent: "worker-a", url: "https://c", apiKey: "cho_k" });
  });

  it("accepts --flag=value form and --args-file", () => {
    const p = parseMcpArgs(["call", "t", "--args-file=./args.json", "--agent=w"]);
    expect(p.argsFile).toBe("./args.json");
    expect(p.creds.agent).toBe("w");
  });

  it("--help short-circuits without an action", () => {
    expect(parseMcpArgs(["--help"]).help).toBe(true);
    expect(parseMcpArgs(["-h"]).help).toBe(true);
  });

  it("whoami / list take no arg flags", () => {
    expect(parseMcpArgs(["whoami", "--agent", "w"]).action).toBe("whoami");
    expect(() => parseMcpArgs(["whoami", "--arg", "a=1"])).toThrow(UsageError);
    expect(() => parseMcpArgs(["list", "extra"])).toThrow(UsageError);
  });

  it("rejects unknown action, unknown flag, missing tool, extra positionals, key-less --arg", () => {
    expect(() => parseMcpArgs(["frobnicate"])).toThrow(/Unknown action/);
    expect(() => parseMcpArgs(["call", "t", "--nope", "x"])).toThrow(/Unknown flag/);
    expect(() => parseMcpArgs(["call"])).toThrow(/requires a <tool>/);
    expect(() => parseMcpArgs(["call", "t", "{}", "extra"])).toThrow(/Too many positional/);
    expect(() => parseMcpArgs(["call", "t", "--arg", "novalue"])).toThrow(/key=value/);
    expect(() => parseMcpArgs(["call", "t", "--arg", "=v"])).toThrow(/empty key/);
  });
});

describe("assembleArgs — base sources", () => {
  it("positional JSON is the base object", () => {
    const p = parseMcpArgs(["call", "t", '{"a":1,"b":"x"}']);
    expect(assembleArgs(p, io())).toEqual({ a: 1, b: "x" });
  });

  it("--args-file reads the base object from a file", () => {
    const p = parseMcpArgs(["call", "t", "--args-file", "./args.json"]);
    expect(assembleArgs(p, io({ files: { "./args.json": '{"k":"v"}' } }))).toEqual({ k: "v" });
  });

  it("--args-file - reads the base from stdin", () => {
    const p = parseMcpArgs(["call", "t", "--args-file", "-"]);
    expect(assembleArgs(p, io({ stdin: '{"fromStdin":true}' }))).toEqual({ fromStdin: true });
  });

  it("no base source yields {}", () => {
    const p = parseMcpArgs(["call", "t"]);
    expect(assembleArgs(p, io())).toEqual({});
  });
});

describe("assembleArgs — file/stdin string filling (json_encode_file replacement)", () => {
  const tricky = '# Title\n\nline with "quotes", \\ backslash, and `code`\n';

  it("--arg-file injects raw bytes as a JSON string, verbatim (not parsed)", () => {
    const p = parseMcpArgs(["call", "t", "--arg", "type=prd", "--arg-file", "content=./d.md"]);
    const out = assembleArgs(p, io({ files: { "./d.md": tricky } }));
    expect(out).toEqual({ type: "prd", content: tricky });
    expect(typeof out.content).toBe("string"); // string, not parsed
  });

  it("@file shorthand behaves like --arg-file", () => {
    const p = parseMcpArgs(["call", "t", "--arg", "content=@./d.md"]);
    expect(assembleArgs(p, io({ files: { "./d.md": tricky } }))).toEqual({ content: tricky });
  });

  it("@- and --arg-file key=- read from stdin", () => {
    expect(assembleArgs(parseMcpArgs(["call", "t", "--arg", "c=@-"]), io({ stdin: "hi" }))).toEqual({
      c: "hi",
    });
    expect(
      assembleArgs(parseMcpArgs(["call", "t", "--arg-file", "c=-"]), io({ stdin: "yo" })),
    ).toEqual({ c: "yo" });
  });

  it("@@ escapes to a literal leading @", () => {
    const p = parseMcpArgs(["call", "t", "--arg", "handle=@@alice"]);
    expect(assembleArgs(p, io())).toEqual({ handle: "@alice" });
  });

  it("later overrides win, applied in command-line order", () => {
    const p = parseMcpArgs([
      "call", "t", '{"k":"base"}',
      "--arg", "k=first",
      "--arg-file", "k=./f",
    ]);
    expect(assembleArgs(p, io({ files: { "./f": "fromFile" } }))).toEqual({ k: "fromFile" });
  });
});

describe("assembleArgs — error paths", () => {
  it("both base sources → UsageError", () => {
    const p = parseMcpArgs(["call", "t", "{}", "--args-file", "./a.json"]);
    expect(() => assembleArgs(p, io({ files: { "./a.json": "{}" } }))).toThrow(/not both/);
  });

  it("two stdin consumers → UsageError", () => {
    const p = parseMcpArgs(["call", "t", "--args-file", "-", "--arg", "c=@-"]);
    expect(() => assembleArgs(p, io({ stdin: "{}" }))).toThrow(/stdin .* one argument/);
  });

  it("malformed JSON base → UsageError", () => {
    const p = parseMcpArgs(["call", "t", "{not json}"]);
    expect(() => assembleArgs(p, io())).toThrow(/Invalid JSON/);
  });

  it("non-object base (array/scalar) → UsageError", () => {
    expect(() => assembleArgs(parseMcpArgs(["call", "t", "[1,2]"]), io())).toThrow(/must be a JSON object/);
    expect(() => assembleArgs(parseMcpArgs(["call", "t", "42"]), io())).toThrow(/must be a JSON object/);
  });

  it("a missing --arg-file / @file path → UsageError (usage, not a raw fs error)", () => {
    // io()'s readFile throws ENOENT for unknown paths; it must surface as UsageError.
    expect(() => assembleArgs(parseMcpArgs(["call", "t", "--arg-file", "c=./nope"]), io())).toThrow(UsageError);
    expect(() => assembleArgs(parseMcpArgs(["call", "t", "--arg", "c=@./nope"]), io())).toThrow(/cannot read file "\.\/nope"/);
  });
});

describe("mcpHelpText", () => {
  it("lists the three actions and the argument flags", () => {
    const h = mcpHelpText("9.9.9");
    expect(h).toContain("chorus mcp call");
    expect(h).toContain("chorus mcp whoami");
    expect(h).toContain("chorus mcp list");
    expect(h).toContain("--arg-file");
    expect(h).toContain("v9.9.9");
  });
});
