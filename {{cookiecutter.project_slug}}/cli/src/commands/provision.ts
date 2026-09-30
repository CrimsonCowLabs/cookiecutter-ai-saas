// `provision` — a straight pass-through to `ansible-playbook -i
// ansible/inventory.ini ansible/provision.yml`, run on the control machine
// (never over cli/src/ssh.ts's remote plumbing — provisioning is what makes
// that plumbing possible in the first place). Every argument opsctl is given
// is handed to ansible-playbook unchanged, so `-e deploy_public_key_file=...`
// or `--ask-vault-pass` work exactly as typing the command by hand — there is
// no friendlier surface to translate here the way `deploy` has one for
// `deploy_targets`.

import { findProjectRootFromCwd } from "../inventory";
import { buildPlaybookArgv, runLocal } from "../ansible";
import type { CliCommand } from "../types";

export const provisionCommand: CliCommand = {
  name: "provision",
  summary: "Provision the host (ansible-playbook ansible/provision.yml); arguments pass through",
  async run(args) {
    const projectRoot = findProjectRootFromCwd(process.cwd());
    return runLocal(buildPlaybookArgv(projectRoot, "provision.yml", args), { cwd: projectRoot });
  },
};
