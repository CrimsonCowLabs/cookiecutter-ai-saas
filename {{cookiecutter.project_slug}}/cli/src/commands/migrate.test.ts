import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMigratePlaybookArgs, parseMigrateArgs } from "./migrate";

test("no arguments: just the migrator, with migrations forced on", () => {
  const parsed = parseMigrateArgs([]);
  assert.deepEqual(parsed, { extra: [] });
  assert.deepEqual(buildMigratePlaybookArgs((parsed as { extra: string[] }).extra), [
    "-e",
    "deploy_targets=migrator",
    "-e",
    "run_migrations=true",
  ]);
});

test("a positional target is refused — migrate has no targets of its own", () => {
  const parsed = parseMigrateArgs(["app"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /takes no targets/);
});

test("arguments after -- pass straight through, appended after the forced flags", () => {
  const parsed = parseMigrateArgs(["--", "-e", "dns_check=false"]);
  assert.deepEqual(parsed, { extra: ["-e", "dns_check=false"] });
  assert.deepEqual(buildMigratePlaybookArgs((parsed as { extra: string[] }).extra), [
    "-e",
    "deploy_targets=migrator",
    "-e",
    "run_migrations=true",
    "-e",
    "dns_check=false",
  ]);
});

test("a target before -- is still refused", () => {
  const parsed = parseMigrateArgs(["app", "--", "-e", "dns_check=false"]);
  assert.ok("error" in parsed);
});
