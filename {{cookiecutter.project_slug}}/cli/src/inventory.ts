// The one place this CLI reads where the host is. `ansible/inventory.ini` and
// `ansible/group_vars/all.yml` are already the single source of truth the
// playbooks read (see the README) — this module reads the same two files
// rather than asking the operator to configure a host a second time.
//
// Both files are parsed with plain line regexes, the same way
// scripts/check_deploy.sh's `read_var()` does it, rather than pulling in a
// YAML/INI library: group_vars/all.yml only ever needs a handful of top-level
// `key: value` lines out of it, and inventory.ini's `[vps]` block is one host
// line plus a handful of `key=value` pairs. A real parser would buy nothing
// here but a dependency.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface HostConfig {
  /** ansible_host from inventory.ini — the address ssh connects to. */
  host: string;
  /** ansible_port, or null to let ssh use its own default (22). */
  port: number | null;
  /** ansible_ssh_private_key_file, `~` already expanded, or null to let ssh
   * (and its agent) pick a key the way it would for any other host. */
  identityFile: string | null;
  /** deploy_user from group_vars/all.yml — the account deploy.yml logs in as. */
  user: string;
  /** app_dir from group_vars/all.yml — where the compose file lives on the host. */
  appDir: string;
  /** project_slug from group_vars/all.yml — the compose `-p` deploy.yml uses. */
  projectSlug: string;
}

/** The generation-time placeholder nobody has filled in yet. */
export const UNSET_HOST_PLACEHOLDER = "YOUR_VPS_IP";

export class InventoryError extends Error {}

function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** key=value pairs off one inventory line, host name (if any) returned separately. */
function parseInventoryLine(line: string): { host?: string; vars: Record<string, string> } {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  const vars: Record<string, string> = {};
  let host: string | undefined;
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq === -1) {
      if (host === undefined) host = token;
      continue;
    }
    vars[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { host, vars };
}

export interface ParsedInventory {
  /** The inventory alias (the domain name, by convention) — not used to
   * connect, but useful to echo back in `config`'s report. */
  alias: string | null;
  ansibleHost: string | null;
  ansiblePort: string | null;
  identityFile: string | null;
}

/** Pure: reads the `[vps]` and `[vps:vars]` blocks out of inventory.ini text.
 * Host-line vars win over group vars, the same precedence Ansible itself uses. */
export function parseInventory(text: string): ParsedInventory {
  const lines = text.split(/\r?\n/);
  let section: string | null = null;
  let alias: string | null = null;
  const vars: Record<string, string> = {};
  let hostVars: Record<string, string> = {};

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section === "vps") {
      const { host, vars: lineVars } = parseInventoryLine(line);
      if (host) alias = host;
      hostVars = { ...hostVars, ...lineVars };
    } else if (section === "vps:vars") {
      const eq = line.indexOf("=");
      if (eq !== -1) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }

  const merged = { ...vars, ...hostVars };
  return {
    alias,
    ansibleHost: merged.ansible_host ?? null,
    ansiblePort: merged.ansible_port ?? null,
    identityFile: merged.ansible_ssh_private_key_file
      ? expandHome(stripQuotes(merged.ansible_ssh_private_key_file))
      : null,
  };
}

export interface ParsedGroupVars {
  deployUser: string | null;
  appDir: string | null;
  projectSlug: string | null;
}

/** Pure: reads the handful of top-level scalars this CLI needs out of
 * group_vars/all.yml. Deliberately not a YAML parser — see the module comment. */
export function parseGroupVars(text: string): ParsedGroupVars {
  const read = (key: string): string | null => {
    const match = text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
    return match ? stripQuotes(match[1]) : null;
  };
  return {
    deployUser: read("deploy_user"),
    appDir: read("app_dir"),
    projectSlug: read("project_slug"),
  };
}

/** Pure: combines both files' output into a HostConfig, or a list of what is
 * missing. Kept separate from the file reads so it can be unit tested with
 * sample text and so `config` can report every problem at once rather than
 * stopping at the first one. */
export function buildHostConfig(
  inventoryText: string,
  groupVarsText: string,
): { config: HostConfig } | { errors: string[] } {
  const inventory = parseInventory(inventoryText);
  const groupVars = parseGroupVars(groupVarsText);
  const errors: string[] = [];

  if (!inventory.ansibleHost) {
    errors.push("no ansible_host in ansible/inventory.ini's [vps] section");
  } else if (inventory.ansibleHost === UNSET_HOST_PLACEHOLDER) {
    errors.push(
      `ansible/inventory.ini still has the placeholder address (${UNSET_HOST_PLACEHOLDER}) — put the server's address there`,
    );
  }
  if (!groupVars.deployUser) errors.push("no deploy_user in ansible/group_vars/all.yml");
  if (!groupVars.appDir) errors.push("no app_dir in ansible/group_vars/all.yml");
  if (!groupVars.projectSlug) errors.push("no project_slug in ansible/group_vars/all.yml");

  if (errors.length > 0) return { errors };

  const port = inventory.ansiblePort ? Number.parseInt(inventory.ansiblePort, 10) : null;
  return {
    config: {
      host: inventory.ansibleHost as string,
      port: port && Number.isFinite(port) ? port : null,
      identityFile: inventory.identityFile,
      user: groupVars.deployUser as string,
      appDir: groupVars.appDir as string,
      projectSlug: groupVars.projectSlug as string,
    },
  };
}

/** Walks upward from `startDir` looking for a directory whose `ansible/`
 * subdirectory has an inventory.ini — the same landmark `README.md` assumes
 * you're standing next to when it says `ansible-playbook -i
 * ansible/inventory.ini ...`. Pure aside from the injected `exists` check, so
 * the walk itself is unit-testable without touching a real filesystem. */
export function findProjectRoot(
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  let dir = startDir;
  for (;;) {
    if (exists(join(dir, "ansible", "inventory.ini"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Reads and combines the two files from a real project root, or throws an
 * `InventoryError` with a message meant to be printed as-is. */
export function loadHostConfig(projectRoot: string): HostConfig {
  const inventoryPath = join(projectRoot, "ansible", "inventory.ini");
  const groupVarsPath = join(projectRoot, "ansible", "group_vars", "all.yml");
  if (!existsSync(inventoryPath)) {
    throw new InventoryError(`no ${inventoryPath} — is this a generated project?`);
  }
  if (!existsSync(groupVarsPath)) {
    throw new InventoryError(`no ${groupVarsPath} — is this a generated project?`);
  }
  const result = buildHostConfig(
    readFileSync(inventoryPath, "utf8"),
    readFileSync(groupVarsPath, "utf8"),
  );
  if ("errors" in result) {
    throw new InventoryError(
      `configuration is incomplete:\n${result.errors.map((e) => `  - ${e}`).join("\n")}\n` +
        "Run `config` for the full picture.",
    );
  }
  return result.config;
}

/** Finds the project root from `cwd`, or throws an `InventoryError` with a
 * message meant to be printed as-is. Every command that shells out to a
 * playbook or to `ansible-vault` needs only this — the inventory file's own
 * path, not a parsed `HostConfig` — since it is Ansible, not this CLI, that
 * reads the inventory for those. */
export function findProjectRootFromCwd(cwd: string): string {
  const root = findProjectRoot(cwd);
  if (!root) {
    throw new InventoryError(
      "no ansible/inventory.ini found in this directory or any parent — run this from inside a generated project",
    );
  }
  return root;
}

/** Finds the project root from `cwd` and loads its HostConfig, for commands
 * that need a fully-configured host to do anything (status, logs, shell,
 * backup). */
export function loadHostConfigFromCwd(cwd: string): HostConfig {
  return loadHostConfig(findProjectRootFromCwd(cwd));
}
