import { test } from "node:test";
import assert from "node:assert/strict";
import { printConfigChecks, runConfigChecks, warningSummary, type ConfigCheck, type ConfigCheckDeps } from "./config";

const INVENTORY = "[vps]\nmyapp.example.com ansible_host=203.0.113.9\n";
const GROUP_VARS = "deploy_user: adalovelace\napp_dir: /app/myapp\nproject_slug: myapp\n";

// The `legal` section of config.ts, as a freshly generated project ships it
// (placeholders) and as an operator fills it in.
const LEGAL_PLACEHOLDERS = {
  minimumAge: "13",
  marketingPostalAddress: '"REPLACE_WITH_MARKETING_POSTAL_ADDRESS"',
  dmcaName: '"REPLACE_WITH_DMCA_AGENT_NAME"',
  dmcaPostalAddress: '"REPLACE_WITH_DMCA_AGENT_POSTAL_ADDRESS"',
  dmcaPhone: '"REPLACE_WITH_DMCA_AGENT_PHONE"',
  dmcaEmail: '"REPLACE_WITH_DMCA_AGENT_EMAIL"',
  accessibilityContactEmail: '"REPLACE_WITH_ACCESSIBILITY_CONTACT_EMAIL"',
};
const LEGAL_FILLED: typeof LEGAL_PLACEHOLDERS = {
  minimumAge: "16",
  marketingPostalAddress: '"1 Main St, Springfield, IL 62701, USA"',
  dmcaName: '"Ada Lovelace"',
  dmcaPostalAddress: '"1 Main St, Springfield, IL 62701, USA"',
  dmcaPhone: '"+1 555 0100"',
  dmcaEmail: '"dmca@example.com"',
  accessibilityContactEmail: '"a11y@example.com"',
};

function configSource(legal: Partial<typeof LEGAL_PLACEHOLDERS> = {}): string {
  const v = { ...LEGAL_PLACEHOLDERS, ...legal };
  return `const config = {
  appName: "myapp",
  stripe: { plans: [{ tier: "free", name: "Free" }] },
  legal: {
    minimumAge: ${v.minimumAge},
    marketingPostalAddress: ${v.marketingPostalAddress},
    dmcaAgent: {
      name: ${v.dmcaName},
      postalAddress: ${v.dmcaPostalAddress},
      phone: ${v.dmcaPhone},
      email: ${v.dmcaEmail},
    },
    accessibility: {
      contactEmail: ${v.accessibilityContactEmail},
      reviewDate: "2026-01-01",
    },
    consentTextVersion: "1",
  },
} satisfies ConfigProps;
`;
}

const CONFIGURED_HOST = {
  "/proj/ansible/inventory.ini": INVENTORY,
  "/proj/ansible/group_vars/all.yml": GROUP_VARS,
  "/proj/ansible/vault.yml": "$ANSIBLE_VAULT;1.1;AES256\n",
};

async function legalChecks(source: string | undefined): Promise<ConfigCheck[]> {
  const files: Record<string, string> = { ...CONFIGURED_HOST };
  if (source !== undefined) files["/proj/config.ts"] = source;
  const checks = await runConfigChecks("/proj", fakeDeps({ files }));
  return checks.filter((c) => c.name.startsWith("legal"));
}

function legalCheck(checks: ConfigCheck[], name: string): ConfigCheck {
  const check = checks.find((c) => c.name === name);
  assert.ok(check, `no ${name} check in ${JSON.stringify(checks.map((c) => c.name))}`);
  return check;
}

function fakeDeps(overrides: Partial<ConfigCheckDeps> & { files?: Record<string, string> } = {}): ConfigCheckDeps {
  const files = overrides.files ?? {};
  return {
    exists: overrides.exists ?? ((path: string) => path in files),
    readFile: overrides.readFile ?? ((path: string) => files[path] ?? ""),
    probeReachable: overrides.probeReachable ?? (async () => true),
  };
}

test("a fully configured, reachable host: everything ok", async () => {
  const deps = fakeDeps({
    files: {
      "/proj/ansible/inventory.ini": INVENTORY,
      "/proj/ansible/group_vars/all.yml": GROUP_VARS,
      "/proj/ansible/vault.yml": "$ANSIBLE_VAULT;1.1;AES256\nabc...\n",
      "/proj/config.ts": configSource(LEGAL_FILLED),
    },
  });
  const checks = await runConfigChecks("/proj", deps);
  assert.deepEqual(
    checks.map((c) => c.status),
    ["ok", "ok", "ok", "ok", "ok", "ok", "ok"],
  );
});

test("no vault.yml at all fails that check by name", async () => {
  const deps = fakeDeps({
    files: {
      "/proj/ansible/inventory.ini": INVENTORY,
      "/proj/ansible/group_vars/all.yml": GROUP_VARS,
    },
  });
  const checks = await runConfigChecks("/proj", deps);
  const vault = checks.find((c) => c.name === "vault");
  assert.equal(vault?.status, "fail");
  assert.match(vault!.detail, /not found/);
});

test("a plaintext vault.yml fails, distinctly from a missing one", async () => {
  const deps = fakeDeps({
    files: {
      "/proj/ansible/inventory.ini": INVENTORY,
      "/proj/ansible/group_vars/all.yml": GROUP_VARS,
      "/proj/ansible/vault.yml": "vault_backup_remote:\n  type: s3\n",
    },
  });
  const checks = await runConfigChecks("/proj", deps);
  const vault = checks.find((c) => c.name === "vault");
  assert.equal(vault?.status, "fail");
  assert.match(vault!.detail, /not encrypted/);
});

test("no host configured skips the SSH probe rather than attempting it", async () => {
  let probed = false;
  const deps = fakeDeps({
    files: { "/proj/ansible/inventory.ini": "[vps]\n", "/proj/ansible/group_vars/all.yml": "" },
    probeReachable: async () => {
      probed = true;
      return true;
    },
  });
  const checks = await runConfigChecks("/proj", deps);
  assert.equal(probed, false);
  assert.equal(checks.find((c) => c.name === "ssh")?.status, "skip");
});

test("printConfigChecks returns the number of failing checks — preflight reuses it as-is", () => {
  const checks: ConfigCheck[] = [
    { name: "inventory", status: "ok", detail: "fine" },
    { name: "vault", status: "fail", detail: "not encrypted" },
    { name: "ssh", status: "fail", detail: "unreachable" },
  ];
  assert.equal(printConfigChecks(checks), 2);
});

test("printConfigChecks returns zero when every check passed", () => {
  const checks: ConfigCheck[] = [{ name: "inventory", status: "ok", detail: "fine" }];
  assert.equal(printConfigChecks(checks), 0);
});

test("a configured but unreachable host fails the SSH check", async () => {
  const deps = fakeDeps({
    files: {
      "/proj/ansible/inventory.ini": INVENTORY,
      "/proj/ansible/group_vars/all.yml": GROUP_VARS,
      "/proj/ansible/vault.yml": "$ANSIBLE_VAULT;1.1;AES256\n",
    },
    probeReachable: async () => false,
  });
  const checks = await runConfigChecks("/proj", deps);
  assert.equal(checks.find((c) => c.name === "ssh")?.status, "fail");
});

test("a freshly generated config.ts warns about every placeholder legal setting, and fails none", async () => {
  const checks = await legalChecks(configSource());
  assert.deepEqual(
    checks.map((c) => [c.name, c.status]),
    [
      ["legal.minimumAge", "ok"],
      ["legal.marketingPostalAddress", "warn"],
      ["legal.dmcaAgent", "warn"],
      ["legal.accessibility.contactEmail", "warn"],
    ],
  );
});

test("a filled-in legal section passes every legal check", async () => {
  const checks = await legalChecks(configSource(LEGAL_FILLED));
  assert.ok(checks.length === 4 && checks.every((c) => c.status === "ok"), JSON.stringify(checks));
});

test("a placeholder marketing postal address warns, pointing at its section of the guide", async () => {
  const check = legalCheck(await legalChecks(configSource()), "legal.marketingPostalAddress");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /docs\/compliance\.md#marketing-email-can-spam/);
});

test("a filled-in marketing postal address passes", async () => {
  const check = legalCheck(
    await legalChecks(
      configSource({
        marketingPostalAddress: LEGAL_FILLED.marketingPostalAddress,
      }),
    ),
    "legal.marketingPostalAddress",
  );
  assert.equal(check.status, "ok");
});

test("an empty marketing postal address warns like a placeholder", async () => {
  const check = legalCheck(
    await legalChecks(configSource({ marketingPostalAddress: '""' })),
    "legal.marketingPostalAddress",
  );
  assert.equal(check.status, "warn");
});

test("the DMCA agent check names each field still a placeholder, and links the registration section", async () => {
  const check = legalCheck(
    await legalChecks(
      configSource({
        dmcaName: LEGAL_FILLED.dmcaName,
        dmcaEmail: LEGAL_FILLED.dmcaEmail,
      }),
    ),
    "legal.dmcaAgent",
  );
  assert.equal(check.status, "warn");
  assert.match(check.detail, /legal\.dmcaAgent\.postalAddress/);
  assert.match(check.detail, /legal\.dmcaAgent\.phone/);
  assert.doesNotMatch(check.detail, /legal\.dmcaAgent\.name/);
  assert.doesNotMatch(check.detail, /legal\.dmcaAgent\.email/);
  assert.match(check.detail, /docs\/compliance\.md#registering-a-designated-agent/);
});

test("a fully filled-in DMCA agent passes", async () => {
  const { dmcaName, dmcaPostalAddress, dmcaPhone, dmcaEmail } = LEGAL_FILLED;
  const check = legalCheck(
    await legalChecks(configSource({ dmcaName, dmcaPostalAddress, dmcaPhone, dmcaEmail })),
    "legal.dmcaAgent",
  );
  assert.equal(check.status, "ok");
});

test("a placeholder accessibility contact warns, pointing at its section of the guide", async () => {
  const check = legalCheck(await legalChecks(configSource()), "legal.accessibility.contactEmail");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /docs\/compliance\.md#accessibility/);
});

test("a filled-in accessibility contact passes", async () => {
  const check = legalCheck(
    await legalChecks(
      configSource({
        accessibilityContactEmail: LEGAL_FILLED.accessibilityContactEmail,
      }),
    ),
    "legal.accessibility.contactEmail",
  );
  assert.equal(check.status, "ok");
});

test("an unset minimum age warns, pointing at its section of the guide", async () => {
  const source = configSource().replace(/^\s*minimumAge:.*\n/m, "");
  const check = legalCheck(await legalChecks(source), "legal.minimumAge");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /docs\/compliance\.md#childrens-privacy-coppa/);
});

test("a minimum age of zero counts as unset", async () => {
  const check = legalCheck(await legalChecks(configSource({ minimumAge: "0" })), "legal.minimumAge");
  assert.equal(check.status, "warn");
});

test("a set minimum age passes and says what it is", async () => {
  const check = legalCheck(await legalChecks(configSource({ minimumAge: "16" })), "legal.minimumAge");
  assert.equal(check.status, "ok");
  assert.match(check.detail, /16/);
});

test("other settings that share a field name do not satisfy the legal checks", async () => {
  // `name` and `email` appear outside dmcaAgent (plan names, resend); only
  // the dmcaAgent block counts.
  const source = configSource().replace(
    "const config = {",
    'const config = {\n  name: "Elsewhere",\n  email: "x@example.com",',
  );
  const check = legalCheck(await legalChecks(source), "legal.dmcaAgent");
  assert.match(check.detail, /legal\.dmcaAgent\.name/);
  assert.match(check.detail, /legal\.dmcaAgent\.email/);
});

test("no config.ts skips the legal checks rather than failing", async () => {
  const checks = await legalChecks(undefined);
  assert.deepEqual(
    checks.map((c) => [c.name, c.status]),
    [["legal", "skip"]],
  );
});

test("printConfigChecks does not count warnings as failures", () => {
  const checks: ConfigCheck[] = [
    { name: "inventory", status: "ok", detail: "fine" },
    { name: "legal.dmcaAgent", status: "warn", detail: "placeholder" },
  ];
  assert.equal(printConfigChecks(checks), 0);
});

test("warningSummary counts warnings for the summary line, and is empty without any", () => {
  const ok: ConfigCheck = { name: "inventory", status: "ok", detail: "fine" };
  const warn: ConfigCheck = { name: "legal.dmcaAgent", status: "warn", detail: "placeholder" };
  assert.equal(warningSummary([ok]), "");
  assert.equal(warningSummary([ok, warn]), ", with 1 warning to fill in before you launch");
  assert.equal(warningSummary([warn, warn]), ", with 2 warnings to fill in before you launch");
});
