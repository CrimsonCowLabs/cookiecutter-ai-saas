// `status` — a thin wrapper around `docker compose ps` on the host. Extra
// arguments pass straight through (`status -a` becomes `docker compose ps
// -a`), so this never needs to grow its own flags to keep up with compose's.

import { loadHostConfigFromCwd } from "../inventory";
import { runCompose } from "../ssh";
import type { CliCommand } from "../types";

export const statusCommand: CliCommand = {
  name: "status",
  summary: "Show container status on the host (docker compose ps)",
  async run(args) {
    const config = loadHostConfigFromCwd(process.cwd());
    return runCompose(config, ["ps", ...args]);
  },
};
