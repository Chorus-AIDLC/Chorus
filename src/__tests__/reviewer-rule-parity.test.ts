// Reviewer-definition parity guard.
//
// The three Chorus reviewers (proposal / task / aggregate-code) are duplicated
// across SEVEN distribution surfaces — 21 files in total — and they are NOT
// verbatim copies of one another: they range 117-226 lines, use three different
// heading idioms (`=== X ===`, `## Title case`, `## Title Case` + `---`), and
// the Kiro surface embeds its whole prompt inside one JSON string field. There
// is no shared include mechanism, so "add a reviewer rule" literally means
// "write it 21 times, adapted to each file's voice".
//
// That has already gone wrong: an earlier change landed its turn-budget wording
// in only 3 of the 6 non-Claude-Code surfaces. This test pins the rules added by
// the trackable-reviewer-findings change so the next edit cannot land on a
// subset of surfaces unnoticed.
//
// Why the path list is hardcoded rather than globbed: a glob would silently
// cover an eighth surface the moment someone added its directory, which is
// exactly the failure we want to be loud about — a new surface must be added
// here deliberately. A glob would also sweep in the stale copies under
// `.next/standalone/`, `packages/chorus-cdk/cdk.out/` and `.claude/worktrees/`,
// which are build artifacts and would keep this test permanently red.
//
// Why the character-cap regex is written generically (`\d+`, optional `~`, and
// several phrasings) rather than pinning 800/1000: the point is not to delete
// two specific numbers, it is that a total-output budget must never come back.
// Every reviewer's output format demands full command/output/evidence for a
// BLOCKER, so any byte budget is paid out of that evidence. Noise is bounded by
// relevance (at most 5 newly-raised NOTEs), not by bytes.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type ReviewerKind = "code" | "task" | "proposal";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** The 21 reviewer definitions: 3 reviewers x 7 surfaces. Hardcoded on purpose. */
const REVIEWER_FILES: ReadonlyArray<{ file: string; kind: ReviewerKind; surface: string }> = [
  // Claude Code plugin (the reference implementation)
  { surface: "claude-code", kind: "code", file: "public/chorus-plugin/agents/code-reviewer.md" },
  { surface: "claude-code", kind: "task", file: "public/chorus-plugin/agents/task-reviewer.md" },
  { surface: "claude-code", kind: "proposal", file: "public/chorus-plugin/agents/proposal-reviewer.md" },
  // Standalone skill (served from public/skill/)
  { surface: "standalone-skill", kind: "code", file: "public/skill/code-reviewer-chorus/SKILL.md" },
  { surface: "standalone-skill", kind: "task", file: "public/skill/task-reviewer-chorus/SKILL.md" },
  { surface: "standalone-skill", kind: "proposal", file: "public/skill/proposal-reviewer-chorus/SKILL.md" },
  // Codex plugin
  { surface: "codex", kind: "code", file: "plugins/chorus/skills/chorus-code-reviewer/SKILL.md" },
  { surface: "codex", kind: "task", file: "plugins/chorus/skills/chorus-task-reviewer/SKILL.md" },
  { surface: "codex", kind: "proposal", file: "plugins/chorus/skills/chorus-proposal-reviewer/SKILL.md" },
  // OpenClaw plugin
  { surface: "openclaw", kind: "code", file: "packages/openclaw-plugin/skills/code-reviewer/SKILL.md" },
  { surface: "openclaw", kind: "task", file: "packages/openclaw-plugin/skills/task-reviewer/SKILL.md" },
  { surface: "openclaw", kind: "proposal", file: "packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md" },
  // Pi plugin
  { surface: "pi", kind: "code", file: "packages/chorus-pi/agents/chorus-code-reviewer.md" },
  { surface: "pi", kind: "task", file: "packages/chorus-pi/agents/chorus-task-reviewer.md" },
  { surface: "pi", kind: "proposal", file: "packages/chorus-pi/agents/chorus-proposal-reviewer.md" },
  // dsh plugin
  { surface: "dsh", kind: "code", file: "packages/chorus-dsh/skills/code-reviewer-chorus/SKILL.md" },
  { surface: "dsh", kind: "task", file: "packages/chorus-dsh/skills/task-reviewer-chorus/SKILL.md" },
  { surface: "dsh", kind: "proposal", file: "packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md" },
  // Kiro plugin (JSON: the whole prompt lives in the `prompt` field)
  { surface: "kiro", kind: "code", file: "public/kiro-plugin/.kiro/agents/chorus-code-reviewer.json" },
  { surface: "kiro", kind: "task", file: "public/kiro-plugin/.kiro/agents/chorus-task-reviewer.json" },
  { surface: "kiro", kind: "proposal", file: "public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json" },
];

const EXPECTED_SURFACES = 7;
const EXPECTED_KINDS = 3;

/** Generated/staged copies that must never be scanned. */
const FORBIDDEN_PATH_FRAGMENTS = [".next/", "cdk.out/", ".claude/worktrees/", "node_modules/"];

/** Reads a reviewer's prompt text; for the Kiro surface, the JSON `prompt` field. */
function readPrompt(file: string): string {
  const raw = readFileSync(path.join(REPO_ROOT, file), "utf8");
  if (!file.endsWith(".json")) return raw;
  const parsed = JSON.parse(raw) as { prompt?: unknown };
  if (typeof parsed.prompt !== "string" || parsed.prompt.length === 0) {
    throw new Error(`${file}: expected a non-empty string \`prompt\` field`);
  }
  return parsed.prompt;
}

/**
 * Any instruction that caps total output. Deliberately generic: a different
 * number, a tilde, bold markers, or "chars" instead of "characters" must all
 * still fail.
 */
const OUTPUT_CAP_PATTERNS: ReadonlyArray<RegExp> = [
  /under\s*\*{0,2}\s*~?\s*[\d,]+\s*\*{0,2}\s*(?:characters|chars)/i,
  /total\s+(?:output\s+)?under\s+[\d,]+/i,
  /(?:character|char|byte)\s+(?:cap|limit|budget)/i,
  /(?:keep|limit)[^.\n]{0,40}\b(?:to|under|below)\s+[\d,]+\s*(?:characters|chars)\b/i,
  // A budget phrased without under/keep/limit, e.g. "Aim for ~450 chars total."
  /(?:aim for|target|roughly|around|approximately|about|no more than|at most)\s*\*{0,2}\s*~?\s*[\d,]+\s*\*{0,2}\s*(?:characters|chars)\b/i,
];

/** Rules every reviewer must carry, whatever its surface or stage. */
const SHARED_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "relevance budget (at most 5 newly-raised NOTEs)", pattern: /at most 5/i },
  {
    label: "NOTE limit governs newly-raised NOTEs only",
    pattern: /governs\s+(?:only\s+)?newly-raised NOTEs|newly-raised NOTEs\s+only/i,
  },
  {
    label: "carried-forward acknowledgement lines are exempt from the NOTE limit",
    pattern: /carried-forward|Prior-findings acknowledgement lines|Prior findings/i,
  },
  { label: "confirm absence before reporting something missing", pattern: /confirm(?:ing|ed)?\s+its\s+absence/i },
  { label: "stable BLOCKER id format", pattern: /B<round>-<slug>/ },
  { label: "stable NOTE id format", pattern: /N<round>-<slug>/ },
  // NOT a bare /\bfixed\b/: the pre-change prose already said "whether previous
  // BLOCKERs were fixed", so a bare word match stays green even if the state
  // definition is deleted outright — i.e. it would guard nothing. Match the
  // definition itself: `fixed` paired with its re-verification requirement.
  {
    label: "acknowledgement state: fixed (defined as re-verified this round)",
    pattern: /`fixed`[^\n]{0,80}re-verif/i,
  },
  { label: "acknowledgement state: still-open", pattern: /still-open/ },
  { label: "acknowledgement state: not-verifiable", pattern: /not-verifiable/ },
  { label: "no fourth acknowledgement state", pattern: /no fourth state/i },
  // The consequence (FAIL) is the load-bearing half of this rule, so the pattern
  // must reach it. An earlier version stopped at `yield`, which made the guard
  // vacuous: flipping every "yields VERDICT: FAIL" to "PASS" in all 21 files
  // still left the suite green. `BLOCKER` is anchored at the front so the match
  // cannot land on the neighbouring "NOTEs never escalate" sentence, which also
  // mentions both states and the word FAIL.
  {
    label: "still-open OR not-verifiable BLOCKER yields VERDICT: FAIL",
    pattern: /BLOCKER[^.\n]{0,80}still-open[^.\n]{0,40}not-verifiable[^.\n]{0,40}yields?[^.\n]{0,28}FAIL/i,
  },
  { label: "silence is not a fix", pattern: /silence is not a fix/i },
  {
    label: "NOTEs never escalate to FAIL",
    pattern: /NOTEs never escalate|never be the reason for a/i,
  },
  {
    label: "pre-existing round-2+ rule still present (not replaced by the NOTE limit)",
    pattern: /introduce new NOTEs?/i,
  },
  { label: "ids are never renamed across rounds", pattern: /never renamed/i },
];

/**
 * One phrase per reviewer that MUST appear in that reviewer and MUST NOT appear
 * in the other two. This is what proves the three exclusion lists did not
 * collapse into a single generic checklist copied three times.
 */
const KIND_ONLY_ANCHORS: Record<ReviewerKind, RegExp> = {
  code: /redo the per-line review/i,
  task: /absent end-to-end integration tests/i,
  proposal: /propose alternative architectures/i,
};

/**
 * Coverage-preservation rules. The DO/NOT-DO lists narrow each gate's scope, and
 * the union of the three gates must still catch everything a feature review
 * should catch. These pin the carve-outs that keep that true — each one exists
 * because its absence created a real hole:
 *
 * - Intent alignment: the DO lists read as exhaustive scope boundaries and did
 *   not name it, contradicting the intent-alignment step in the same file and
 *   threatening to silently drop the capability PR #545 shipped.
 * - Evidence bar: requiring run evidence for any BLOCKER demoted
 *   statically-visible defects (missing authz, missing tenant scoping) to NOTE,
 *   and made the shell-less Kiro code/task reviewers structurally unable to
 *   return FAIL at all.
 * - Pre-existing carve-out: a latent bug the change makes reachable was excluded
 *   by the task gate AND the aggregate gate, so it fell through both.
 * - Delegated gaps must name their owning gate, so "not mine" never means "nobody's".
 */
const COVERAGE_RULES: Partial<Record<ReviewerKind, ReadonlyArray<{ label: string; pattern: RegExp }>>> = {
  task: [
    {
      label: "intent alignment is explicitly exempt from the AC/diff scope boundary",
      pattern: /intent-alignment step[^.\n]{0,120}(?:in scope|IN scope)|never (?:counts as|")?wider/i,
    },
    {
      label: "a pre-existing defect this change makes reachable stays in scope",
      pattern: /makes? one reachable|makes one reachable, worse/i,
    },
    { label: "delegated inter-task gaps name the owning gate", pattern: /aggregate code reviewer owns inter-task gaps/i },
    { label: "severity is not lowered for lack of a shell", pattern: /as written|never lower/i },

    // The AC are authored before the code exists, so they describe what to build
    // and never how well it was built. Without these, a defect no criterion
    // happens to mention had no owner: the task gate was AC-driven and the
    // aggregate gate declines to "redo the per-line review each task passed".
    {
      label: "the AC are a floor, not a ceiling",
      pattern: /not a reason to stay silent|no AC covers it/i,
    },
    { label: "correctness is checked without an AC", pattern: /correctness without an AC/i },
    {
      label: "reimplementation preference order, with the existing thing named",
      pattern: /reimplementation/i,
    },
    {
      label: "a brevity opinion with nothing named is not a finding",
      pattern: /nothing named is not a finding/i,
    },
    {
      // The aggregate gate's security dimension is scoped to risk that appears
      // only when tasks are combined, so a hole one task wrote alone had no gate.
      label: "security defects in this task's own code are BLOCKER-bearing",
      pattern: /security in this task'?s own code/i,
    },
    { label: "a test that cannot fail leaves its AC unverified", pattern: /tests that cannot fail/i },
    { label: "silent failure is BLOCKER-bearing", pattern: /silent failure/i },
    {
      // Anchored on "Taste never blocks", which appears only in the block's own
      // severity paragraph. A bare /name the concrete defect/ would be vacuous:
      // the rewritten classification rule carries that phrase too, so deleting
      // the paragraph outright would still have passed.
      label: "quality findings block only on a nameable concrete defect",
      pattern: /Taste never blocks/i,
    },
  ],
  code: [
    { label: "feature-level intent drift is named in the DO list", pattern: /intent drift/i },
    { label: "severity is not lowered for lack of a shell", pattern: /as written|never lower/i },
  ],
};

/** Superseded wording that must not come back. */
const SUPERSEDED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    // Re-verification narrowed to BLOCKER-tied files makes a prior NOTE in any
    // other file permanently `not-verifiable` — the ledger could never close it,
    // which contradicts the archived reviewer-finding-identity spec.
    label: "round-2+ re-verification narrowed to BLOCKERs only",
    pattern: /tied to previous BLOCKERs/i,
  },
  {
    // Demoted every statically-visible defect to NOTE; see COVERAGE_RULES above.
    label: "run-evidence-only BLOCKER bar",
    pattern: /BLOCKER (?:requires|needs) demonstration/i,
  },
  {
    // Contradicts the reimplementation, verification-integrity and security
    // dimensions: a duplicated utility and a tautological test are neither
    // functional nor behavioural, yet both are BLOCKERs.
    label: "BLOCKER severity restricted to functional/behavioural issues alone",
    pattern: /only functional ?\/? ?\/? ?behavio[u]?ral issues/i,
  },
];

/**
 * State words that would imply a fourth acknowledgement state. Deliberately
 * limited to hyphenated state-shaped tokens: a bare prose word like
 * "acknowledged" appears in legitimate sentences about the acknowledgement
 * block itself, so listing it here would fail a future honest edit rather than
 * catch a real fourth state.
 */
const FORBIDDEN_STATE_WORDS = /still-present|wont-?fix|partially-fixed|in-progress|re-opened/i;

/** Both were explicitly rejected by the human who scoped this change. */
const REJECTED_CONSTRUCTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    // Allows for markup wrappers (`**SCOPE:**`, `### COVERAGE:`, `- SCOPE:`) —
    // a bare /^\s*(?:SCOPE|COVERAGE):/ would miss the bolded form, which is how
    // these files write most of their labels.
    label: "verdict header format (SCOPE:/COVERAGE: lines)",
    pattern: /^\s*(?:[-*#>\s]|\*\*|__)*(?:SCOPE|COVERAGE)\s*:?\s*(?:\*\*|__)?\s*:/m,
  },
  { label: "fourth verdict value", pattern: /VERDICT:\s*INCOMPLETE/i },
];

describe("reviewer definition parity across all surfaces", () => {
  it("covers exactly 3 reviewers x 7 surfaces, with no generated copies", () => {
    expect(REVIEWER_FILES).toHaveLength(EXPECTED_KINDS * EXPECTED_SURFACES);

    const surfaces = new Set(REVIEWER_FILES.map((r) => r.surface));
    expect(surfaces.size).toBe(EXPECTED_SURFACES);

    // every surface must define all three reviewers
    for (const surface of surfaces) {
      const kinds = REVIEWER_FILES.filter((r) => r.surface === surface).map((r) => r.kind).sort();
      expect(kinds, `surface ${surface} must define all three reviewers`).toEqual([
        "code",
        "proposal",
        "task",
      ]);
    }

    for (const { file } of REVIEWER_FILES) {
      for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
        expect(file, `${file} must not point at a generated copy`).not.toContain(fragment);
      }
    }
  });

  // Kiro is the only surface whose tool grant is declarative, so it is the only
  // one where the stated posture can be checked against the real grant rather
  // than against prose. All three reviewers get read-only shell (the code and
  // task reviewers previously had none, which left them unable to run the very
  // build/test their review procedure is built around) and none gets `write`.
  describe.each(REVIEWER_FILES.filter((r) => r.surface === "kiro"))(
    "kiro tool grant — $kind",
    ({ file }) => {
      const declared = JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as {
        tools?: string[];
      };

      it("grants read + read-only shell + @chorus, and never write", () => {
        expect(declared.tools, `${file}: unexpected tool grant`).toEqual(["read", "shell", "@chorus"]);
      });

      it("states a read-only shell posture instead of claiming it has no shell", () => {
        const prompt = readPrompt(file);
        const denies = prompt.match(/no `?shell`?\b|cannot run shell|reading is your only confirmation/i);
        expect(
          denies?.[0] ?? null,
          `${file} still claims it has no shell while the grant includes one — stated posture must match the real grant`,
        ).toBeNull();
        expect(
          /READ-ONLY inspection|read-only shell/i.test(prompt),
          `${file} must bound its shell to read-only inspection in the prompt, since Kiro's tools field has no per-command allow-list`,
        ).toBe(true);
      });
    },
  );

  describe.each(REVIEWER_FILES)("$surface / $kind ($file)", ({ file, kind }) => {
    const prompt = readPrompt(file);

    it("imposes no total-output character cap", () => {
      for (const pattern of OUTPUT_CAP_PATTERNS) {
        const match = prompt.match(pattern);
        expect(
          match?.[0] ?? null,
          `${file} reintroduces a total-output cap (${pattern}). Output must be bounded by ` +
            `relevance — at most 5 newly-raised NOTEs — never by a byte budget, because a byte ` +
            `budget is paid out of BLOCKER evidence.`,
        ).toBeNull();
      }
    });

    it.each(SHARED_RULES)("carries the rule: $label", ({ pattern }) => {
      expect(pattern.test(prompt), `${file} is missing this rule (${pattern})`).toBe(true);
    });

    it("declares its own stage-specific exclusion list, not a shared generic one", () => {
      expect(
        KIND_ONLY_ANCHORS[kind].test(prompt),
        `${file} is missing the ${kind}-reviewer's own exclusion rule`,
      ).toBe(true);

      for (const otherKind of Object.keys(KIND_ONLY_ANCHORS) as ReviewerKind[]) {
        if (otherKind === kind) continue;
        expect(
          KIND_ONLY_ANCHORS[otherKind].test(prompt),
          `${file} (a ${kind} reviewer) contains the ${otherKind} reviewer's exclusion rule — ` +
            `the three lists must stay stage-specific rather than collapsing into one checklist`,
        ).toBe(false);
      }
    });

    it("uses exactly the three acknowledgement states", () => {
      const stray = prompt.match(FORBIDDEN_STATE_WORDS);
      expect(
        stray?.[0] ?? null,
        `${file} introduces a fourth acknowledgement state; the vocabulary is exactly ` +
          `fixed / still-open / not-verifiable`,
      ).toBeNull();
    });

    it.each(REJECTED_CONSTRUCTS)("omits the human-rejected $label", ({ pattern }) => {
      const match = prompt.match(pattern);
      expect(match?.[0] ?? null, `${file} reintroduces a construct the human rejected`).toBeNull();
    });

    it.each(SUPERSEDED)("does not reinstate the superseded $label", ({ pattern }) => {
      const match = prompt.match(pattern);
      expect(
        match?.[0] ?? null,
        `${file} reinstates wording that created a coverage hole — see COVERAGE_RULES for why`,
      ).toBeNull();
    });

    const coverage = COVERAGE_RULES[kind] ?? [];
    if (coverage.length > 0) {
      it.each(coverage)("preserves coverage: $label", ({ pattern }) => {
        expect(
          pattern.test(prompt),
          `${file} drops a carve-out that keeps the three gates' combined coverage complete (${pattern})`,
        ).toBe(true);
      });
    }

    // Guard on the guard. A pattern that matches the real file proves nothing
    // about whether it would catch the rule being reversed — the previous
    // version of the FAIL pattern matched all 21 files while a wholesale
    // "FAIL" -> "PASS" flip stayed green. Mutating the text in memory and
    // asserting the pattern now fails is the only check that distinguishes a
    // real guard from a vacuous one. In memory only: nothing is written.
    it("would catch the FAIL consequence being reversed to PASS", () => {
      const failRule = SHARED_RULES.find((r) => r.label.includes("yields VERDICT: FAIL"));
      expect(failRule, "the FAIL-consequence rule must exist to be mutation-checked").toBeDefined();

      const mutated = prompt.replace(/yields(\s+`?VERDICT:\s*)FAIL/gi, "yields$1PASS");
      expect(
        mutated,
        `${file} — the mutation must actually change the text, or this check is vacuous`,
      ).not.toBe(prompt);
      expect(
        failRule!.pattern.test(mutated),
        `${file} — the FAIL-consequence pattern still matches after the consequence was ` +
          `flipped to PASS, so it does not guard the rule it names`,
      ).toBe(false);
    });
  });
});
