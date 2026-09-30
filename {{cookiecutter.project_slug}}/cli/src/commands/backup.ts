// `backup` — take one backup right now, by starting the systemd service
// ansible/backup.yml already installed on the host: `sudo systemctl start
// <slug>-db-backup.service`, exactly the command the README tells an
// operator to run by hand after installing backups. This deliberately does
// NOT run `ansible-playbook ansible/backup.yml` — that playbook installs or
// updates the *schedule* (and re-asserts every install-time precondition: a
// reachable destination, a running Postgres to dump), it does not take a
// dump itself. Wrapping the systemd unit is what "an on-demand backup" in
// the issue actually means, and it is the one write verb that reaches over
// ssh rather than running a playbook locally — see cli/src/ssh.ts, the same
// plumbing `status`/`logs`/`shell` use.
//
// `systemctl start` on a oneshot unit blocks until the unit finishes and
// exits nonzero if it failed (scripts/check_backups.sh relies on the same
// behaviour), so this command's own exit code is already the backup's.

import { basename } from "node:path";
import { loadHostConfigFromCwd, type HostConfig } from "../inventory";
import { runSsh, shellQuote } from "../ssh";
import type { CliCommand } from "../types";

/** The systemd unit ansible/backup.yml names the schedule after:
 * `backup_name: "{{ app_dir | basename }}-db-backup"` in
 * group_vars/all.yml. Derived from `app_dir` rather than `project_slug`
 * because that is what the playbook itself derives it from — the two agree
 * only for as long as `app_dir` ends in the slug, which is the default and
 * not enforced. An operator who overrides `backup_name` directly (rather
 * than `app_dir`) is outside what this CLI parses, the same limit
 * inventory.ts's module comment already documents for the handful of scalars
 * it reads. */
export function backupServiceUnit(config: Pick<HostConfig, "appDir">): string {
  return `${basename(config.appDir)}-db-backup`;
}

export const backupCommand: CliCommand = {
  name: "backup",
  summary: "Take a backup now (systemctl start <slug>-db-backup.service on the host)",
  async run(args) {
    if (args.length > 0) {
      console.error("usage: backup (no arguments)");
      return 1;
    }
    const config = loadHostConfigFromCwd(process.cwd());
    const unit = `${backupServiceUnit(config)}.service`;
    return runSsh(config, `sudo systemctl start ${shellQuote(unit)}`);
  },
};
