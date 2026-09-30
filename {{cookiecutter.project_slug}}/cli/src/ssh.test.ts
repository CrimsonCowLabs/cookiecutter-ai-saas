import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRemoteCommand, buildSshArgv, composeBaseArgv, shellQuote } from "./ssh";
import type { HostConfig } from "./inventory";

const CONFIG: HostConfig = {
  host: "203.0.113.9",
  port: null,
  identityFile: null,
  user: "adalovelace",
  appDir: "/app/myapp",
  projectSlug: "myapp",
};

test("shellQuote wraps a plain value in single quotes", () => {
  assert.equal(shellQuote("app"), "'app'");
});

test("shellQuote escapes an embedded single quote", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("shellQuote is a no-op on the empty string other than the quotes", () => {
  assert.equal(shellQuote(""), "''");
});

test("composeBaseArgv matches ansible/deploy.yml's own invocation", () => {
  assert.deepEqual(composeBaseArgv(CONFIG), [
    "docker",
    "compose",
    "-p",
    "myapp",
    "-f",
    "docker-compose.prod.yml",
    "--env-file",
    ".env-production",
  ]);
});

test("buildRemoteCommand cds into app_dir before running compose", () => {
  const command = buildRemoteCommand(CONFIG, ["ps"]);
  assert.equal(
    command,
    "cd '/app/myapp' && 'docker' 'compose' '-p' 'myapp' '-f' 'docker-compose.prod.yml' '--env-file' '.env-production' 'ps'",
  );
});

test("buildRemoteCommand quotes an argument containing a space or quote safely", () => {
  const command = buildRemoteCommand(CONFIG, ["exec", "-it", "app", "sh", "-c", "echo it's a test"]);
  assert.ok(command.includes("'echo it'\\''s a test'"));
});

test("buildSshArgv omits -p and -i when the inventory names neither", () => {
  assert.deepEqual(buildSshArgv(CONFIG, "true"), ["ssh", "adalovelace@203.0.113.9", "true"]);
});

test("buildSshArgv adds -p and -i only when the inventory sets them", () => {
  const withPortAndKey: HostConfig = { ...CONFIG, port: 2222, identityFile: "/home/ada/.ssh/id_ed25519" };
  assert.deepEqual(buildSshArgv(withPortAndKey, "true"), [
    "ssh",
    "-p",
    "2222",
    "-i",
    "/home/ada/.ssh/id_ed25519",
    "adalovelace@203.0.113.9",
    "true",
  ]);
});

test("buildSshArgv adds -t only when tty is requested", () => {
  assert.deepEqual(buildSshArgv(CONFIG, "true", { tty: true }), [
    "ssh",
    "-t",
    "adalovelace@203.0.113.9",
    "true",
  ]);
});

test("buildSshArgv places extraArgs before the destination", () => {
  const argv = buildSshArgv(CONFIG, "true", { extraArgs: ["-o", "BatchMode=yes"] });
  assert.deepEqual(argv, ["ssh", "-o", "BatchMode=yes", "adalovelace@203.0.113.9", "true"]);
});
