// `secrets edit` — a thin wrapper around `ansible-vault edit
// ansible/vault.yml`, run locally with the terminal's stdio inherited so the
// operator's own $EDITOR opens exactly as it would running the command by
// hand, and the file is never decrypted to disk in between (see
// ansible/vault.yml.example's header comment). This CLI does not touch vault
// crypto itself — `edit` is the only subcommand, on purpose.

import { findProjectRootFromCwd } from "../inventory";
import { buildVaultEditArgv, runLocal } from "../ansible";
import type { CliCommand } from "../types";

export const secretsCommand: CliCommand = {
  name: "secrets",
  summary: "edit — ansible-vault edit ansible/vault.yml; the only subcommand, never decrypted to disk",
  async run(args) {
    if (args.length !== 1 || args[0] !== "edit") {
      console.error("usage: secrets edit");
      return 1;
    }
    const projectRoot = findProjectRootFromCwd(process.cwd());
    return runLocal(buildVaultEditArgv(projectRoot), { cwd: projectRoot });
  },
};
