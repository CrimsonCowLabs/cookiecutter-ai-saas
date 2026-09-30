#!/usr/bin/env node
import { parseArgs } from "./args";
import { commands, findCommand } from "./commands/registry";
import { helpText, RESTORE_NOTE } from "./help";
import { InventoryError } from "./inventory";

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
    // (missing/placeholder host, unencrypted vault, ...); anything else is
    // unexpected and gets its stack, not just a message.
    if (error instanceof InventoryError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
