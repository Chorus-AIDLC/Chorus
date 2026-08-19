import rootConfig from "../../eslint.config.mjs";

export default [
  ...rootConfig,
  {
    files: ["**/*.{ts,mts,cts}"],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
