import type { CliCommand } from "./types";

export const CLI_NAME = "opsctl";

export function helpText(commands: CliCommand[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    `${CLI_NAME} — operate a deployed instance over SSH, using your own ssh config and agent.`,
    "",
    `usage: ${CLI_NAME} <command> [args...]`,
    "",
    "commands:",
    ...lines,
    "",
    "Host, user and paths all come from ansible/inventory.ini and",
    "ansible/group_vars/all.yml — there is nothing else to configure here.",
  ].join("\n");
}
