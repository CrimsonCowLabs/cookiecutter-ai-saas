// `deploy [targets...]` — `ansible-playbook -i ansible/inventory.ini
// ansible/deploy.yml`, translating this CLI's positional targets and
// `--no-migrate` flag into the `-e deploy_targets=...`/`-e
// run_migrations=false` overrides the README's own table already documents.
// Nothing here invents a target vocabulary: whatever the operator types is
// joined with commas and handed straight to `deploy_targets`, and
// ansible/deploy.yml's own "Refuse an unknown deploy target" assertion is
// what validates it — the same as if they had typed the `-e` themselves.
//
// `opsctl deploy` with no targets deploys everything, because that is what
// running ansible-playbook with no `deploy_targets` override already does
// (group_vars/all.yml's own default). So the unqualified command can never
// ship *less* than that default; naming targets only ever narrows it.
//
// Extra ansible-playbook arguments (another `-e`, `--ask-vault-pass`, ...) go
// after a literal `--`, the same convention `npm run`/`kubectl` use: without
// it, a flag's own value (`-e dns_check=false`) would be indistinguishable
// from a deploy target, since neither this CLI nor deploy.yml know the set of
// valid `-e` names up front.

import { findProjectRootFromCwd } from "../inventory";
import { buildPlaybookArgv, runLocal } from "../ansible";
import type { CliCommand } from "../types";

const NO_MIGRATE_FLAG = "--no-migrate";

export interface DeployPlan {
  /** Target image names, e.g. ["app", "worker"], or [] for "everything" —
   * deploy.yml's own default, left un-overridden. */
  targets: string[];
  /** `-e run_migrations=false` when true; otherwise left at deploy.yml's own
   * default (true) rather than a redundant explicit `=true`. */
  noMigrate: boolean;
  /** Raw ansible-playbook arguments from after a `--`, passed through
   * verbatim and last. */
  extra: string[];
}

export type ParsedDeployArgs = { plan: DeployPlan } | { error: string };

/** Pure: argv (already past the command name) to a DeployPlan, or a message
 * to print and fail on. A token starting with `-` before `--` is refused
 * rather than treated as a target, since a mistyped flag silently becoming a
 * deploy target is exactly the "fuzzy default" this command should not have. */
export function parseDeployArgs(args: string[]): ParsedDeployArgs {
  const sepIndex = args.indexOf("--");
  const front = sepIndex === -1 ? args : args.slice(0, sepIndex);
  const extra = sepIndex === -1 ? [] : args.slice(sepIndex + 1);

  let noMigrate = false;
  const targets: string[] = [];
  for (const token of front) {
    if (token === NO_MIGRATE_FLAG) {
      noMigrate = true;
      continue;
    }
    if (token.startsWith("-")) {
      return {
        error: `unknown flag before targets: ${token} (extra ansible-playbook arguments go after a literal --)`,
      };
    }
    targets.push(token);
  }
  return { plan: { targets, noMigrate, extra } };
}

/** Pure: a DeployPlan to the ansible-playbook arguments after the playbook
 * path — `-e deploy_targets=...` only when targets were actually named, `-e
 * run_migrations=false` only when asked, then whatever followed `--`. */
export function buildDeployPlaybookArgs(plan: DeployPlan): string[] {
  const args: string[] = [];
  if (plan.targets.length > 0) {
    args.push("-e", `deploy_targets=${plan.targets.join(",")}`);
  }
  if (plan.noMigrate) {
    args.push("-e", "run_migrations=false");
  }
  args.push(...plan.extra);
  return args;
}

export const deployCommand: CliCommand = {
  name: "deploy",
  summary: "Deploy (ansible-playbook ansible/deploy.yml) [targets...] [--no-migrate] [-- extra args]",
  async run(args) {
    const parsed = parseDeployArgs(args);
    if ("error" in parsed) {
      console.error(parsed.error);
      console.error("usage: deploy [target...] [--no-migrate] [-- ansible-playbook args...]");
      return 1;
    }
    const projectRoot = findProjectRootFromCwd(process.cwd());
    const playbookArgs = buildDeployPlaybookArgs(parsed.plan);
    return runLocal(buildPlaybookArgv(projectRoot, "deploy.yml", playbookArgs), { cwd: projectRoot });
  },
};
