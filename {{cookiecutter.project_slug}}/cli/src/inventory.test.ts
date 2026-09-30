import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHostConfig,
  findProjectRoot,
  parseGroupVars,
  parseInventory,
  UNSET_HOST_PLACEHOLDER,
} from "./inventory";

const SAMPLE_INVENTORY = `
# a comment
[vps]
myapp.example.com ansible_host=203.0.113.9

[vps:vars]
ansible_ssh_common_args=-o StrictHostKeyChecking=accept-new
# ansible_port=2222
`;

const SAMPLE_GROUP_VARS = `
---
deploy_user: adalovelace
app_dir: /app/myapp
project_slug: myapp
postgres_db: "{{ project_slug | replace('-', '_') }}"
`;

test("parseInventory reads ansible_host off the [vps] host line", () => {
  const result = parseInventory(SAMPLE_INVENTORY);
  assert.equal(result.alias, "myapp.example.com");
  assert.equal(result.ansibleHost, "203.0.113.9");
  assert.equal(result.ansiblePort, null, "commented-out vars are not read");
  assert.equal(result.identityFile, null);
});

test("parseInventory prefers a host-line var over the same key in [vps:vars]", () => {
  const text = `
[vps]
host ansible_host=1.2.3.4 ansible_port=2200

[vps:vars]
ansible_port=22
`;
  assert.equal(parseInventory(text).ansiblePort, "2200");
});

test("parseInventory expands a ~ in the identity file", () => {
  const text = `
[vps]
host ansible_host=1.2.3.4 ansible_ssh_private_key_file=~/.ssh/id_ed25519
`;
  const result = parseInventory(text);
  assert.ok(result.identityFile?.endsWith("/.ssh/id_ed25519"));
  assert.ok(!result.identityFile?.startsWith("~"));
});

test("parseGroupVars reads the top-level scalars this CLI needs", () => {
  const result = parseGroupVars(SAMPLE_GROUP_VARS);
  assert.deepEqual(result, {
    deployUser: "adalovelace",
    appDir: "/app/myapp",
    projectSlug: "myapp",
  });
});

test("buildHostConfig succeeds when both files are complete", () => {
  const result = buildHostConfig(SAMPLE_INVENTORY, SAMPLE_GROUP_VARS);
  assert.ok("config" in result, "expected a config, not errors");
  if ("config" in result) {
    assert.deepEqual(result.config, {
      host: "203.0.113.9",
      port: null,
      identityFile: null,
      user: "adalovelace",
      appDir: "/app/myapp",
      projectSlug: "myapp",
    });
  }
});

test("buildHostConfig reports every missing piece, not just the first", () => {
  const result = buildHostConfig("[vps]\nhost ansible_host=YOUR_VPS_IP\n", "---\n");
  assert.ok("errors" in result);
  if ("errors" in result) {
    assert.equal(result.errors.length, 4);
    assert.ok(result.errors.some((e) => e.includes(UNSET_HOST_PLACEHOLDER)));
    assert.ok(result.errors.some((e) => e.includes("deploy_user")));
    assert.ok(result.errors.some((e) => e.includes("app_dir")));
    assert.ok(result.errors.some((e) => e.includes("project_slug")));
  }
});

test("buildHostConfig rejects a missing ansible_host distinctly from the placeholder", () => {
  const result = buildHostConfig("[vps]\n", "---\n");
  assert.ok("errors" in result);
  if ("errors" in result) {
    assert.ok(result.errors.some((e) => e.includes("no ansible_host")));
  }
});

test("findProjectRoot walks upward until it finds ansible/inventory.ini", () => {
  const filesystem = new Set(["/home/ada/project/ansible/inventory.ini"]);
  const exists = (path: string) => filesystem.has(path);
  assert.equal(findProjectRoot("/home/ada/project/app/api", exists), "/home/ada/project");
  assert.equal(findProjectRoot("/home/ada/project", exists), "/home/ada/project");
});

test("findProjectRoot returns null when nothing is found up to the root", () => {
  assert.equal(findProjectRoot("/home/ada/elsewhere", () => false), null);
});
