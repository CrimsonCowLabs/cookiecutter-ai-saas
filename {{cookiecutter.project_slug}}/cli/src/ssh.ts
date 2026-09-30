// Shells out to the system `ssh` and `docker` — never a library that manages
// its own keys or known_hosts. Whatever the operator's `~/.ssh/config` and
// agent already do (host aliases, jump hosts, ProxyCommand, agent
// forwarding, an offered key) keeps doing it here, because this process is
// the same `ssh` binary they'd type by hand.
//
// The commands and flags mirror ansible/deploy.yml's own `docker compose`
// invocation (`-p <project_slug> -f docker-compose.prod.yml --env-file
// .env-production ...`, run with the host's app_dir as the working
// directory) so there is exactly one shape of that command in the repo, not
// one the playbook uses and a slightly different one this CLI does.

import { spawn } from "node:child_process";
import type { HostConfig } from "./inventory";

export const COMPOSE_FILE = "docker-compose.prod.yml";
export const ENV_FILE = ".env-production";

/** POSIX single-quote escaping, for building the one remote command string
 * ssh is handed. `'` becomes `'\''`: close the quote, an escaped literal
 * quote, reopen it. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The `docker compose ...` argv that runs on the host, before the verb
 * (`ps`, `logs`, `exec`, ...) and its own arguments. */
export function composeBaseArgv(config: HostConfig): string[] {
  return ["docker", "compose", "-p", config.projectSlug, "-f", COMPOSE_FILE, "--env-file", ENV_FILE];
}

/** The full remote command, as one shell-quoted string: `cd <app_dir> &&
 * docker compose ... <composeArgs>`. One string because that is what ssh
 * hands to the login shell on the other end — passing the words as separate
 * ssh arguments would have ssh join them with spaces anyway, so quoting them
 * ourselves is what keeps a service name or path with a space in it intact. */
export function buildRemoteCommand(config: HostConfig, composeArgs: string[]): string {
  const argv = [...composeBaseArgv(config), ...composeArgs];
  return `cd ${shellQuote(config.appDir)} && ${argv.map(shellQuote).join(" ")}`;
}

export interface SshOptions {
  /** Allocate a pty (`-t`). Required for an interactive shell; not needed
   * for a one-shot command whose output is just read. */
  tty?: boolean;
  /** Extra ssh options placed right after the host/port/identity ones —
   * currently unused by any command, here so a later one does not need to
   * change this function's shape to add one. */
  extraArgs?: string[];
}

/** The `ssh ...` argv for one HostConfig and remote command. Only ever adds
 * `-p`/`-i` when the inventory actually names a non-default port or key;
 * everything else is left to the operator's own ssh config. */
export function buildSshArgv(config: HostConfig, remoteCommand: string, options: SshOptions = {}): string[] {
  const argv: string[] = ["ssh"];
  if (config.port) argv.push("-p", String(config.port));
  if (config.identityFile) argv.push("-i", config.identityFile);
  if (options.tty) argv.push("-t");
  if (options.extraArgs) argv.push(...options.extraArgs);
  argv.push(`${config.user}@${config.host}`);
  argv.push(remoteCommand);
  return argv;
}

/** Runs `docker compose <composeArgs>` on the host, with the local terminal's
 * stdio wired straight through — the same thing typing the ssh command by
 * hand would give you, including a real interactive session when `tty` is
 * set. Resolves to the child's exit code (or 130 if it died to a signal, the
 * usual shell convention) rather than throwing, since a non-zero compose exit
 * is an ordinary outcome here, not a bug in this CLI. */
export function runCompose(config: HostConfig, composeArgs: string[], options: SshOptions = {}): Promise<number> {
  const remoteCommand = buildRemoteCommand(config, composeArgs);
  const argv = buildSshArgv(config, remoteCommand, options);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

/** A quiet, bounded reachability probe: `ssh -o BatchMode=yes -o
 * ConnectTimeout=<n> ... true`. BatchMode is the one place this CLI adds an
 * ssh option beyond port/identity, and only here — `config` needs a yes/no
 * answer rather than a password prompt it would otherwise sit at forever;
 * every other command leaves ssh's own prompting behaviour alone. */
export function probeSshReachable(config: HostConfig, timeoutSeconds = 5): Promise<boolean> {
  const argv = buildSshArgv(config, "true", {
    extraArgs: ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeoutSeconds}`],
  });
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
