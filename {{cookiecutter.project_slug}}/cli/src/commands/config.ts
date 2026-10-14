// `config` — the first-run check. It observes three things a fresh clone
// needs before any other verb can do anything, and changes nothing:
//
//   1. is a host configured in ansible/inventory.ini (not the generation-time
//      placeholder)?
//   2. does ansible/vault.yml exist, and does it actually look encrypted?
//   3. does the host answer over SSH, as the deploy account, right now?
//
// It also warns about legal settings in config.ts still left as their
// generation-time placeholders (see `legalReadinessChecks`). Those are
// warnings, not failures: a fresh clone still has to work for local
// development and CI, but nobody should launch with them.
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

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

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

  const configPath = join(projectRoot, "config.ts");
  if (!deps.exists(configPath)) {
    checks.push({ name: "legal", status: "skip", detail: "config.ts not found — is this a generated project?" });
  } else {
    checks.push(...legalReadinessChecks(deps.readFile(configPath)));
  }

  return checks;
}

const PLACEHOLDER_PREFIX = "REPLACE_WITH_";
const GUIDE = "docs/compliance.md";

/** Reads the `legal` section of config.ts as text — the CLI cannot import the
 * app's own config — and warns about each setting an operator must supply
 * that is still a placeholder. A setting given as an expression rather than a
 * literal (say, `process.env.X`) counts as filled in: this cannot tell. */
export function legalReadinessChecks(configSource: string): ConfigCheck[] {
  const legal = objectBody(stripComments(configSource), "legal");
  const checks: ConfigCheck[] = [];

  const minimumAge = rawValue(legal, "minimumAge");
  const age = minimumAge === null ? NaN : Number(minimumAge);
  if (minimumAge === null || ["undefined", "null"].includes(minimumAge) || (!Number.isNaN(age) && age <= 0)) {
    checks.push(warning("legal.minimumAge", "is unset", "childrens-privacy-coppa"));
  } else {
    checks.push({
      name: "legal.minimumAge",
      status: "ok",
      detail: `visitors under ${minimumAge} cannot sign up`,
    });
  }

  checks.push(
    isPlaceholder(rawValue(legal, "marketingPostalAddress"))
      ? warning("legal.marketingPostalAddress", "is still a placeholder", "marketing-email-can-spam")
      : { name: "legal.marketingPostalAddress", status: "ok", detail: "set" },
  );

  const dmcaAgent = objectBody(legal, "dmcaAgent");
  const unsetDmca = ["name", "postalAddress", "phone", "email"].filter((field) =>
    isPlaceholder(rawValue(dmcaAgent, field)),
  );
  checks.push(
    unsetDmca.length > 0
      ? warning(
          "legal.dmcaAgent",
          `${unsetDmca.map((field) => `legal.dmcaAgent.${field}`).join(", ")} ${
            unsetDmca.length === 1 ? "is still a placeholder" : "are still placeholders"
          }`,
          "registering-a-designated-agent",
        )
      : {
          name: "legal.dmcaAgent",
          status: "ok",
          detail: "name, postal address, phone and email set",
        },
  );

  checks.push(
    isPlaceholder(rawValue(objectBody(legal, "accessibility"), "contactEmail"))
      ? warning("legal.accessibility.contactEmail", "is still a placeholder", "accessibility")
      : {
          name: "legal.accessibility.contactEmail",
          status: "ok",
          detail: "set",
        },
  );

  return checks;
}

/** A legal-readiness warning. `problem` reads after the setting's name, which
 * the printed line already starts with. */
function warning(name: string, problem: string, guideSection: string): ConfigCheck {
  return {
    name,
    status: "warn",
    detail: `${problem} in config.ts — fill in before you launch; see ${GUIDE}#${guideSection}`,
  };
}

/** True for a missing setting, an empty string or a REPLACE_WITH_ placeholder. */
function isPlaceholder(value: string | null): boolean {
  if (value === null) return true;
  const literal = value.match(/^(["'`])(.*)\1$/);
  if (!literal) return false;
  const text = literal[2].trim();
  return text === "" || text.startsWith(PLACEHOLDER_PREFIX);
}

/** The source text of `key`'s value — a whole string literal, or anything
 * else up to the comma or line end that closes it — looked up only at the top
 * level of `body` (not inside nested objects). */
function rawValue(body: string, key: string): string | null {
  const value = String.raw`((["'\`])(?:\\.|(?!\2)[^\\])*\2|[^,\n]+)`;
  const match = topLevel(body).match(new RegExp(String.raw`(?:^|[\s,{])${key}\s*:\s*` + value));
  return match ? match[1].trim() : null;
}

/** The text inside the braces of the first `key: { ... }` in `source`, or ""
 * when there is no such object. */
function objectBody(source: string, key: string): string {
  const match = new RegExp(String.raw`(?:^|[\s,{])${key}\s*:\s*\{`).exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const end = matchingBrace(source, start);
  return source.slice(start, end);
}

/** `body` with every nested `{ ... }` blanked out, so a key lookup only sees
 * this level. String contents are kept as they are. */
function topLevel(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === '"' || body[i] === "'" || body[i] === "`") {
      const end = stringEnd(body, i);
      out += body.slice(i, end + 1);
      i = end + 1;
    } else if (body[i] === "{") {
      const end = matchingBrace(body, i + 1);
      out += " ".repeat(end + 1 - i);
      i = end + 1;
    } else {
      out += body[i];
      i += 1;
    }
  }
  return out;
}

/** End of the string literal opening at `start`: the index of its closing quote. */
function stringEnd(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length && source[i] !== source[start]) i += source[i] === "\\" ? 2 : 1;
  return i;
}

/** `source` with its comments removed, string literals left as they are, so
 * a comment mentioning a setting cannot be read as the setting. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = stringEnd(source, i);
      out += source.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Index of the "}" closing a brace opened just before `from`, skipping
 * braces inside string literals. The end of `source` if none. */
function matchingBrace(source: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = stringEnd(source, i);
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return source.length;
}

/** Prints one line per check and returns how many failed (a warning is not a
 * failure) — shared with `preflight`, which runs these same checks before
 * adding deploy.yml's own vault/DNS preflight, rather than forking a second
 * copy of this logic. */
export function printConfigChecks(checks: ConfigCheck[]): number {
  for (const check of checks) {
    console.log(`[${check.status}]`.padEnd(7), `${check.name}:`, check.detail);
  }
  return checks.filter((c) => c.status === "fail").length;
}

export const configCommand: CliCommand = {
  name: "config",
  summary: "Check first-run configuration: inventory, vault, SSH reachability, legal settings",
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
      console.log(`\n${failures} problem${failures === 1 ? "" : "s"} found${warningSummary(checks)}.`);
      return 1;
    }
    console.log(`\nLooks good${warningSummary(checks)}.`);
    return 0;
  },
};

/** ", with N warnings to fill in before you launch" when any check warned,
 * else "", for the summary line `config` and `preflight` print. */
export function warningSummary(checks: ConfigCheck[]): string {
  const warnings = checks.filter((c) => c.status === "warn").length;
  if (warnings === 0) return "";
  return `, with ${warnings} warning${warnings === 1 ? "" : "s"} to fill in before you launch`;
}
