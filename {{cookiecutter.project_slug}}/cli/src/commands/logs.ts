// `logs` — a thin wrapper around `docker compose logs`. Everything after the
// command name passes straight through, so the follow option is just
// compose's own: `logs app -f`, `logs --tail=100 worker`, `logs` for every
// service. There is no argument this command understands itself.

import { loadHostConfigFromCwd } from "../inventory";
import { runCompose } from "../ssh";
import type { CliCommand } from "../types";

export const logsCommand: CliCommand = {
  name: "logs",
  summary: "Show logs from the host (docker compose logs; pass -f to follow)",
  async run(args) {
    const config = loadHostConfigFromCwd(process.cwd());
    return runCompose(config, ["logs", ...args]);
  },
};
