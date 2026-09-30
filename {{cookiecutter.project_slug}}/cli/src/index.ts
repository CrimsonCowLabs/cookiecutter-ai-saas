#!/usr/bin/env node
import { parseArgs } from "./args";
import { commands, findCommand } from "./commands/registry";
import { helpText, RESTORE_NOTE } from "./help";
import { InventoryError } from "./inventory";

/** Node's spawn() rejects with a plain Error carrying `code: "ENOENT"` and
 * `path: <argv[0]>` when the binary itself isn't found (as opposed to the
 * binary running and failing, which resolves with a nonzero exit code
 * instead — see runLocal/runSsh). */
function isMissingBinaryError(error: unknown): error is NodeJS.ErrnoException & { path: string } {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ENOENT" &&
    typeof (error as NodeJS.ErrnoException).path === "string"
  );
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === null || parsed.isHelp) {
    console.log(helpText(commands));
    return 0;
  }

  // No `restore` entry in the registry, deliberately (see ansible/backup.yml
  // and the README's "Database backups" section): an untested restore script
  // is worse than none. Naming it here, rather than letting it fall through
  // to "Unknown command", is what makes that an answer instead of an absence.
  if (parsed.command === "restore") {
    console.error(RESTORE_NOTE);
    return 1;
  }

  const command = findCommand(parsed.command);
  if (!command) {
    console.error(`Unknown command: ${parsed.command}\n`);
    console.error(helpText(commands));
    return 1;
  }

  try {
    return await command.run(parsed.rest);
  } catch (error) {
    // InventoryError messages are already written for a human to read
    // (missing/placeholder host, unencrypted vault, ...).
    if (error instanceof InventoryError) {
      console.error(error.message);
    } else if (isMissingBinaryError(error)) {
      // Every write verb shells out to ansible-playbook/ansible-vault (and
      // the read-only ones to ssh/docker); on a machine where one of those
      // is not installed yet, node's raw ENOENT with a stack trace reads like
      // a bug in opsctl rather than a missing prerequisite. Name the binary
      // and point at the doc that says how to get it.
      console.error(`${error.path}: command not found — install it and make sure it is on PATH.`);
    } else {
      // Anything else is genuinely unexpected and gets its stack, not just a
      // message.
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
