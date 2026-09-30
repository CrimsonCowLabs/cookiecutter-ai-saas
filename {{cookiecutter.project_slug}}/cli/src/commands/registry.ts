// Every verb this CLI knows about, in the order `--help` lists them. Issue
// #21 shipped the four read-only ones (config, status, logs, shell); issue
// #22 adds the write verbs (provision, deploy, migrate, secrets, backup,
// preflight) as more entries in this same array — nothing here needed to
// change shape to take them. `restore` is deliberately not an entry; see
// index.ts for why running it still gets an answer.

import { configCommand } from "./config";
import { statusCommand } from "./status";
import { logsCommand } from "./logs";
import { shellCommand } from "./shell";
import { provisionCommand } from "./provision";
import { deployCommand } from "./deploy";
import { migrateCommand } from "./migrate";
import { secretsCommand } from "./secrets";
import { backupCommand } from "./backup";
import { preflightCommand } from "./preflight";
import type { CliCommand } from "../types";

export const commands: CliCommand[] = [
  configCommand,
  statusCommand,
  logsCommand,
  shellCommand,
  provisionCommand,
  deployCommand,
  migrateCommand,
  secretsCommand,
  backupCommand,
  preflightCommand,
];

export function findCommand(name: string): CliCommand | undefined {
  return commands.find((command) => command.name === name);
}
