// Shells out to the real `ansible-playbook` and `ansible-vault` binaries,
// run *locally* against this project's own `ansible/inventory.ini` — never
// over cli/src/ssh.ts's remote plumbing. `provision`, `deploy`, `migrate` and
// `preflight` all run on the control machine, exactly the commands the
// README already tells an operator to type by hand; only `backup` reaches
// over ssh (see commands/backup.ts), because it starts something the
// playbooks already installed on the host rather than running a playbook
// itself.
//
// Nothing here parses a playbook or reimplements what one does — this module
// only builds the argv README.md already documents and runs it, the same
// principle cli/src/ssh.ts applies to `docker compose`.

import { spawn } from "node:child_process";
import { join } from "node:path";

export const ANSIBLE_PLAYBOOK_BIN = "ansible-playbook";
export const ANSIBLE_VAULT_BIN = "ansible-vault";

export function inventoryPath(projectRoot: string): string {
  return join(projectRoot, "ansible", "inventory.ini");
}

export function vaultPath(projectRoot: string): string {
  return join(projectRoot, "ansible", "vault.yml");
}

function playbookPath(projectRoot: string, playbook: string): string {
  return join(projectRoot, "ansible", playbook);
}

/** The `ansible-playbook -i ansible/inventory.ini ansible/<playbook>
 * [args...]` argv every playbook is invoked with — the same shape the README
 * shows an operator typing, so there is exactly one form of this command
 * whether a human or opsctl runs it. `args` is appended verbatim: it is
 * whatever tags, `-e` overrides or other ansible-playbook flags the caller
 * has already decided on. */
export function buildPlaybookArgv(projectRoot: string, playbook: string, args: string[] = []): string[] {
  return [ANSIBLE_PLAYBOOK_BIN, "-i", inventoryPath(projectRoot), playbookPath(projectRoot, playbook), ...args];
}

/** The `ansible-vault edit ansible/vault.yml` argv — the exact command
 * vault.yml.example's own header comment gives for changing a secret without
 * ever writing plaintext to disk. */
export function buildVaultEditArgv(projectRoot: string): string[] {
  return [ANSIBLE_VAULT_BIN, "edit", vaultPath(projectRoot)];
}

/** Runs argv[0] with the local terminal's stdio wired straight through —
 * ansible-playbook's own progress output and prompts (`--ask-vault-pass`,
 * `ansible-vault edit`'s `$EDITOR`) reach the operator exactly as they would
 * running the command by hand. Resolves to the child's exit code (128+signal
 * on a signal) rather than throwing, the same convention
 * cli/src/ssh.ts's runCompose uses — a nonzero exit from a playbook is an
 * ordinary outcome here, not a bug in this CLI. */
export function runLocal(argv: string[], options: { cwd: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", cwd: options.cwd });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}
