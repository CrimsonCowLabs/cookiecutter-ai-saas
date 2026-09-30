const HELP_ALIASES = new Set(["help", "--help", "-h"]);

export interface ParsedArgs {
  /** null for no command at all (bare `opsctl`); commands can still choose
   * to treat any name as a help alias, but the dispatcher only needs this. */
  command: string | null;
  isHelp: boolean;
  rest: string[];
}

/** Pure: argv (already sliced past `node script.js`) to a command name and
 * its own arguments. No flag parsing beyond recognising a request for help —
 * every command interprets its own `rest` however it needs to. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined) return { command: null, isHelp: true, rest: [] };
  if (HELP_ALIASES.has(first)) return { command: null, isHelp: true, rest };
  return { command: first, isHelp: false, rest };
}
