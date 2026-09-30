// `migrate` — run pending database migrations and ship nothing else. Not a
// new capability: ansible/deploy.yml already treats `migrator` as an
// ordinary deploy target (it is one of `deploy_images`' keys), and shipping
// only it is enough to run the migrations without shipping app, worker,
// db-writer or ops — `deploy_shipped` is `deploy_requested` plus `migrator`,
// which for `deploy_targets=migrator` is just `[migrator]`. So this is
// `ansible-playbook ansible/deploy.yml -e deploy_targets=migrator`, composing
// a flag deploy.yml's own comments already document rather than adding any
// Ansible-side behaviour.
//
// `-e run_migrations=true` is added explicitly, even though it is
// deploy.yml's own default, so that an operator who has set
// `run_migrations=false` in group_vars/all.yml for routine deploys still gets
// migrations from a command whose entire point is to run them — a verb named
// `migrate` that silently no-ops would be exactly the "fuzzy default" this
// CLI is meant to avoid.
//
// Takes no targets of its own — it always runs only the migrator. Extra
// ansible-playbook arguments still go after a literal `--`, as in `deploy`.

import { findProjectRootFromCwd } from "../inventory";
import { buildPlaybookArgv, runLocal } from "../ansible";
import type { CliCommand } from "../types";

export type ParsedMigrateArgs = { extra: string[] } | { error: string };

/** Pure: argv (already past the command name) to the extra ansible-playbook
 * arguments after `--`, or a message to print and fail on if anything came
 * before it — `migrate` has no targets of its own to accept. */
export function parseMigrateArgs(args: string[]): ParsedMigrateArgs {
  const sepIndex = args.indexOf("--");
  const front = sepIndex === -1 ? args : args.slice(0, sepIndex);
  if (front.length > 0) {
    return {
      error: `migrate takes no targets — it always runs only the migrator. Unexpected argument(s): ${front.join(" ")} (extra ansible-playbook arguments go after a literal --)`,
    };
  }
  return { extra: sepIndex === -1 ? [] : args.slice(sepIndex + 1) };
}

/** Pure: the extra ansible-playbook arguments to the full argument list after
 * the playbook path. */
export function buildMigratePlaybookArgs(extra: string[]): string[] {
  return ["-e", "deploy_targets=migrator", "-e", "run_migrations=true", ...extra];
}

export const migrateCommand: CliCommand = {
  name: "migrate",
  summary: "Run pending migrations only (ansible/deploy.yml -e deploy_targets=migrator), shipping nothing else",
  async run(args) {
    const parsed = parseMigrateArgs(args);
    if ("error" in parsed) {
      console.error(parsed.error);
      console.error("usage: migrate [-- ansible-playbook args...]");
      return 1;
    }
    const projectRoot = findProjectRootFromCwd(process.cwd());
    const playbookArgs = buildMigratePlaybookArgs(parsed.extra);
    return runLocal(buildPlaybookArgv(projectRoot, "deploy.yml", playbookArgs), { cwd: projectRoot });
  },
};
