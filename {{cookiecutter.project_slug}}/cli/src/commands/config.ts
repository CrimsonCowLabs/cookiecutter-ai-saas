// `config` — the first-run check. It observes three things a fresh clone
// needs before any other verb can do anything, and changes nothing:
//
//   1. is a host configured in ansible/inventory.ini (not the generation-time
//      placeholder)?
//   2. does ansible/vault.yml exist, and does it actually look encrypted?
//   3. does the host answer over SSH, as the deploy account, right now?
//
// This is deliberately smaller than a full deploy preflight (DNS, the
// migrator image, disk space, ...) — that check earns its keep by running
// immediately before a deploy and belongs with the write verbs that wrap
// ansible/deploy.yml, not here. This one only answers "can I even start".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHostConfig, findProjectRoot, type HostConfig } from "../inventory";
import { probeSshReachable } from "../ssh";
import type { CliCommand } from "../types";

export type CheckStatus = "ok" | "fail" | "skip";

export interface ConfigCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ConfigCheckDeps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  probeReachable: (config: HostConfig) => Promise<boolean>;
}

const defaultDeps: ConfigCheckDeps = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  probeReachable: probeSshReachable,
};

/** Pure-ish (the only side effects are the injected `deps`) so the reporting
 * logic below can be tested against fake files and a fake ssh probe. */
export async function runConfigChecks(projectRoot: string, deps: ConfigCheckDeps = defaultDeps): Promise<ConfigCheck[]> {
  const checks: ConfigCheck[] = [];

  const inventoryPath = join(projectRoot, "ansible", "inventory.ini");
  const groupVarsPath = join(projectRoot, "ansible", "group_vars", "all.yml");
  let hostConfig: HostConfig | null = null;

  if (!deps.exists(inventoryPath) || !deps.exists(groupVarsPath)) {
    checks.push({
      name: "inventory",
      status: "fail",
      detail: "ansible/inventory.ini or ansible/group_vars/all.yml is missing — is this a generated project?",
    });
  } else {
    const result = buildHostConfig(deps.readFile(inventoryPath), deps.readFile(groupVarsPath));
    if ("errors" in result) {
      checks.push({ name: "inventory", status: "fail", detail: result.errors.join("; ") });
    } else {
      hostConfig = result.config;
      checks.push({
        name: "inventory",
        status: "ok",
        detail: `${result.config.user}@${result.config.host}:${result.config.port ?? 22} -> ${result.config.appDir}`,
      });
    }
  }

  const vaultPath = join(projectRoot, "ansible", "vault.yml");
  if (!deps.exists(vaultPath)) {
    checks.push({
      name: "vault",
      status: "fail",
      detail: "ansible/vault.yml not found — see README \"Deploying\" (cp ansible/vault.yml.example ...)",
    });
  } else {
    const firstLine = deps.readFile(vaultPath).split(/\r?\n/, 1)[0] ?? "";
    checks.push(
      firstLine.startsWith("$ANSIBLE_VAULT")
        ? { name: "vault", status: "ok", detail: "ansible/vault.yml is encrypted" }
        : {
            name: "vault",
            status: "fail",
            detail: "ansible/vault.yml exists but is not encrypted — run `ansible-vault encrypt ansible/vault.yml`",
          },
    );
  }

  if (!hostConfig) {
    checks.push({ name: "ssh", status: "skip", detail: "no host configured yet" });
  } else {
    const reachable = await deps.probeReachable(hostConfig);
    checks.push(
      reachable
        ? { name: "ssh", status: "ok", detail: `${hostConfig.user}@${hostConfig.host} answers over SSH` }
        : {
            name: "ssh",
            status: "fail",
            detail: `${hostConfig.user}@${hostConfig.host} did not answer over SSH — check the address, the port and that your agent holds the right key`,
          },
    );
  }

  return checks;
}

/** Prints one line per check and returns how many failed — shared with
 * `preflight`, which runs these same checks before adding deploy.yml's own
 * vault/DNS preflight, rather than forking a second copy of this logic. */
export function printConfigChecks(checks: ConfigCheck[]): number {
  for (const check of checks) {
    console.log(`[${check.status}]`.padEnd(7), `${check.name}:`, check.detail);
  }
  return checks.filter((c) => c.status === "fail").length;
}

export const configCommand: CliCommand = {
  name: "config",
  summary: "Check first-run configuration: inventory, vault, SSH reachability",
  async run() {
    const projectRoot = findProjectRoot(process.cwd());
    if (!projectRoot) {
      console.error(
        "no ansible/inventory.ini found in this directory or any parent — run this from inside a generated project",
      );
      return 1;
    }

    const checks = await runConfigChecks(projectRoot);
    const failures = printConfigChecks(checks);
    if (failures > 0) {
      console.log(`\n${failures} problem${failures === 1 ? "" : "s"} found.`);
      return 1;
    }
    console.log("\nLooks good.");
    return 0;
  },
};
