import type { CliCommand } from "./types";

export const CLI_NAME = "opsctl";

// Restore is deliberately not a command — see ansible/backup.yml and the
// README's "Database backups" section: an untested restore script is worse
// than none, because it produces false confidence. This is what makes that
// absence a documented decision rather than a silent one, both in `--help`
// and when someone actually types `opsctl restore` (see index.ts).
export const RESTORE_NOTE =
  'There is no "restore" command. Restoring a backup is a deliberate, manual, ' +
  'four-step procedure — see "Database backups" in the README (the root ' +
  "README for this template, or the generated project's own README under the " +
  "same heading) — run once against a throwaway database before you ever need " +
  "it for real.";

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
    "",
    RESTORE_NOTE,
  ].join("\n");
}
