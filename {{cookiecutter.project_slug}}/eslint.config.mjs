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
];

export default config;
