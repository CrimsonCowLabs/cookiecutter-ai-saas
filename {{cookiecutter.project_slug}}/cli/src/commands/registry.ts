// Every verb this CLI knows about, in the order `--help` lists them. Issue
// #21 ships the four read-only ones below; issue #22's write verbs
// (`provision`, `deploy`, `secrets`, `backup`, `preflight`) are more entries
// in this same array, each wrapping its own playbook the way these wrap
// `docker compose` — nothing here needs to change shape to take them.

import { configCommand } from "./config";
import { statusCommand } from "./status";
import { logsCommand } from "./logs";
import { shellCommand } from "./shell";
import type { CliCommand } from "../types";

export const commands: CliCommand[] = [configCommand, statusCommand, logsCommand, shellCommand];

export function findCommand(name: string): CliCommand | undefined {
  return commands.find((command) => command.name === name);
}
