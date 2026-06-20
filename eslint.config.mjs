import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Build artifacts + generated output must never be linted as source. Besides
    // the framework outputs, this excludes: agent worktrees under `.claude/`, CDK
    // synth output (`cdk.out/` — bundled repo snapshots), Astro's generated
    // `.astro/`, test coverage reports, and COMPILED CDK output (`.js`/`.d.ts`
    // emitted next to the CDK `.ts` source) — all transient and otherwise drowning
    // a real lint run in tens of thousands of false errors from minified/generated
    // code. NOTE: the CDK `.ts` SOURCE under `packages/chorus-cdk/{lib,bin}` is
    // deliberately NOT ignored — only its compiled siblings are — so real CDK
    // source is still linted (no silent error).
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      ".claude/**",
      "coverage/**",
      "**/cdk.out/**",
      "**/.astro/**",
      "packages/chorus-cdk/**/*.js",
      "packages/chorus-cdk/**/*.d.ts",
      "next-env.d.ts",
      "src/generated/**",
      "src/**/__tests__/**",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
  },
  {
    rules: {
      "no-console": "warn",
    },
  },
];

export default eslintConfig;
