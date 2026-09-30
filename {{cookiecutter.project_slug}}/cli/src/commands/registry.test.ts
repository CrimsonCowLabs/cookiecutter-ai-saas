import { test } from "node:test";
import assert from "node:assert/strict";
import { commands, findCommand } from "./registry";

test("every command has a unique, non-empty name and summary", () => {
  const names = new Set<string>();
  for (const command of commands) {
    assert.ok(command.name.length > 0);
    assert.ok(command.summary.length > 0);
    assert.ok(!names.has(command.name), `duplicate command name: ${command.name}`);
    names.add(command.name);
  }
});

test("the read-only verbs from issue #21 are all registered", () => {
  for (const name of ["config", "status", "logs", "shell"]) {
    assert.ok(findCommand(name), `expected a "${name}" command`);
  }
});

test("findCommand returns undefined for an unknown name", () => {
  assert.equal(findCommand("does-not-exist"), undefined);
});
