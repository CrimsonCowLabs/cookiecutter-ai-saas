// `shell` — `docker compose exec -it <service> <command>`, with the local
// terminal handed straight through for a real interactive session. The
// service name is required; the command defaults to `sh` (present on every
// image this template ships, including the Alpine-based ones) and can be
// overridden for a one-off command instead of a login shell.

import { loadHostConfigFromCwd } from "../inventory";
import { runCompose } from "../ssh";
import type { CliCommand } from "../types";

const DEFAULT_SHELL = "sh";

export const shellCommand: CliCommand = {
  name: "shell",
  summary: "Open an interactive shell in a service (docker compose exec)",
  async run(args) {
    const [service, ...command] = args;
    if (!service) {
      console.error("usage: shell <service> [command...]");
      console.error(`  (defaults to '${DEFAULT_SHELL}' when no command is given)`);
      return 1;
    }
    const config = loadHostConfigFromCwd(process.cwd());
    const remoteCommand = command.length > 0 ? command : [DEFAULT_SHELL];
    return runCompose(config, ["exec", "-it", service, ...remoteCommand], { tty: true });
  },
};
