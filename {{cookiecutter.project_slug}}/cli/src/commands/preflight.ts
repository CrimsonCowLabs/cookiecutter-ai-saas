// `preflight` — everything `config` already checks, plus
// `ansible-playbook ansible/deploy.yml --tags preflight`, the exact command
// root README's "Deploying" table lists for "check the vault and DNS, deploy
// nothing". This is a superset of `config`, not a fork of it: it calls
// `runConfigChecks`/`printConfigChecks` from ./config rather than
// re-implementing what they check.
//
// Why both halves are needed, worked out by reading deploy.yml's own
// preflight play rather than assumed:
//
//   * Missing configuration — no vault, or one that is not encrypted — IS
//     checked by deploy.yml's own preflight play (it refuses before anything
//     else runs). `config`'s vault check duplicates that on purpose, so a
//     fresh clone gets the same answer without shelling out to
//     ansible-playbook at all.
//   * Unresolved DNS is deploy.yml's own preflight play end to end: it
//     resolves the served name and the target host and compares them. This
//     command does not re-implement that; it just runs the playbook.
//   * An unreachable host is the one thing deploy.yml's `--tags preflight`
//     does NOT check: that play runs with `connection: local` and is tagged
//     `preflight` on its own, so `--tags preflight` never touches the second
//     play, which is the only one that connects to the host over ssh. Only
//     `config`'s own ssh probe (cli/src/ssh.ts's `probeSshReachable`) catches
//     that gap — which is why this command runs `config`'s checks at all,
//     rather than only forwarding to the playbook.
//
// A placeholder inventory address is also `config`'s to catch by name;
// deploy.yml would otherwise report it as an ordinary DNS resolution failure,
// which is correct but less immediately actionable.

import { findProjectRoot } from "../inventory";
import { buildPlaybookArgv, runLocal } from "../ansible";
import { runConfigChecks, printConfigChecks } from "./config";
import type { CliCommand } from "../types";

export const preflightCommand: CliCommand = {
  name: "preflight",
  summary: "Everything config checks, plus deploy.yml's own vault/DNS preflight; deploys nothing",
  async run(args) {
    const projectRoot = findProjectRoot(process.cwd());
    if (!projectRoot) {
      console.error(
        "no ansible/inventory.ini found in this directory or any parent — run this from inside a generated project",
      );
      return 1;
    }

    console.log("==> opsctl config's own checks (inventory, vault, SSH reachability)\n");
    const checks = await runConfigChecks(projectRoot);
    const configFailures = printConfigChecks(checks);

    console.log("\n==> ansible-playbook ansible/deploy.yml --tags preflight (vault and DNS)\n");
    const playbookCode = await runLocal(buildPlaybookArgv(projectRoot, "deploy.yml", ["--tags", "preflight", ...args]), {
      cwd: projectRoot,
    });

    if (configFailures > 0 || playbookCode !== 0) {
      console.log(
        `\n${configFailures} configuration problem${configFailures === 1 ? "" : "s"} found` +
          (playbookCode !== 0 ? ", and deploy.yml's own preflight failed (see above)." : "."),
      );
      return 1;
    }
    console.log("\nLooks good — a deploy can proceed.");
    return 0;
  },
};
