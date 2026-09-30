#!/usr/bin/env node
import { parseArgs } from "./args";
import { commands, findCommand } from "./commands/registry";
import { helpText } from "./help";
import { InventoryError } from "./inventory";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === null || parsed.isHelp) {
    console.log(helpText(commands));
    return 0;
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
