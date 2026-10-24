import next from "eslint-config-next";

// `next lint` was removed in Next 16, so ESLint runs directly against this flat
// config (see the `lint` script in package.json).
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      // The Python worker. workers/db-writer is JavaScript and IS linted.
      "workers/app/**",
      "lib/db/migrations/**",
      // Compiled output of cli/src — the CLI's own TypeScript IS linted.
      "cli/dist/**",
    ],
  },
  ...next,
  {
    // lib/zod.ts sets zod up to run under the Content-Security-Policy before
    // any schema is built; a schema built from "zod" directly may not be.
    ignores: ["lib/zod.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "zod", message: 'Import { z } from "@/lib/zod" instead (see that file).' }] },
      ],
    },
  },
];

export default config;
