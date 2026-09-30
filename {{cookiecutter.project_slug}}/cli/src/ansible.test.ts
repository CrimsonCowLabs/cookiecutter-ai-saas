import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaybookArgv, buildVaultEditArgv, inventoryPath, vaultPath } from "./ansible";

test("inventoryPath and vaultPath live under <root>/ansible", () => {
  assert.equal(inventoryPath("/proj"), "/proj/ansible/inventory.ini");
  assert.equal(vaultPath("/proj"), "/proj/ansible/vault.yml");
});

test("buildPlaybookArgv matches the command the README documents", () => {
  assert.deepEqual(buildPlaybookArgv("/proj", "provision.yml"), [
    "ansible-playbook",
    "-i",
    "/proj/ansible/inventory.ini",
    "/proj/ansible/provision.yml",
  ]);
});

test("buildPlaybookArgv appends extra arguments verbatim, in order", () => {
  assert.deepEqual(buildPlaybookArgv("/proj", "deploy.yml", ["--tags", "preflight", "-e", "dns_check=false"]), [
    "ansible-playbook",
    "-i",
    "/proj/ansible/inventory.ini",
    "/proj/ansible/deploy.yml",
    "--tags",
    "preflight",
    "-e",
    "dns_check=false",
  ]);
});

test("buildVaultEditArgv matches vault.yml.example's own documented command", () => {
  assert.deepEqual(buildVaultEditArgv("/proj"), ["ansible-vault", "edit", "/proj/ansible/vault.yml"]);
});
