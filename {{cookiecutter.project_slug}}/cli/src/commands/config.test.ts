import { test } from "node:test";
import assert from "node:assert/strict";
import { runConfigChecks, type ConfigCheckDeps } from "./config";

const INVENTORY = "[vps]\nmyapp.example.com ansible_host=203.0.113.9\n";
const GROUP_VARS = "deploy_user: adalovelace\napp_dir: /app/myapp\nproject_slug: myapp\n";

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
    },
  });
  const checks = await runConfigChecks("/proj", deps);
  assert.deepEqual(
    checks.map((c) => c.status),
    ["ok", "ok", "ok"],
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
