import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeployPlaybookArgs, parseDeployArgs, type DeployPlan } from "./deploy";

test("no arguments means everything, with migrations on — deploy.yml's own default", () => {
  const parsed = parseDeployArgs([]);
  assert.ok("plan" in parsed);
  const plan = (parsed as { plan: DeployPlan }).plan;
  assert.deepEqual(plan, { targets: [], noMigrate: false, extra: [] });
  assert.deepEqual(buildDeployPlaybookArgs(plan), []);
});

test("a single target becomes -e deploy_targets=<target>", () => {
  const parsed = parseDeployArgs(["app"]);
  assert.ok("plan" in parsed);
  assert.deepEqual(buildDeployPlaybookArgs((parsed as { plan: DeployPlan }).plan), ["-e", "deploy_targets=app"]);
});

test("several targets are joined with commas, in the order given", () => {
  const parsed = parseDeployArgs(["worker", "db-writer"]);
  assert.ok("plan" in parsed);
  assert.deepEqual(buildDeployPlaybookArgs((parsed as { plan: DeployPlan }).plan), [
    "-e",
    "deploy_targets=worker,db-writer",
  ]);
});

test("--no-migrate adds -e run_migrations=false", () => {
  const parsed = parseDeployArgs(["app", "--no-migrate"]);
  assert.ok("plan" in parsed);
  const plan = (parsed as { plan: DeployPlan }).plan;
  assert.equal(plan.noMigrate, true);
  assert.deepEqual(buildDeployPlaybookArgs(plan), ["-e", "deploy_targets=app", "-e", "run_migrations=false"]);
});

test("omitting --no-migrate never adds a redundant run_migrations=true", () => {
  const parsed = parseDeployArgs(["app"]);
  assert.ok("plan" in parsed);
  assert.ok(!buildDeployPlaybookArgs((parsed as { plan: DeployPlan }).plan).includes("run_migrations=true"));
});

test("arguments after -- pass straight through, appended last", () => {
  const parsed = parseDeployArgs(["app", "--", "-e", "dns_check=false", "--ask-vault-pass"]);
  assert.ok("plan" in parsed);
  const plan = (parsed as { plan: DeployPlan }).plan;
  assert.deepEqual(plan.extra, ["-e", "dns_check=false", "--ask-vault-pass"]);
  assert.deepEqual(buildDeployPlaybookArgs(plan), [
    "-e",
    "deploy_targets=app",
    "-e",
    "dns_check=false",
    "--ask-vault-pass",
  ]);
});

test("a bare -- with nothing before it means every target, with extra args passed through", () => {
  const parsed = parseDeployArgs(["--", "-e", "site_address=https://localhost"]);
  assert.ok("plan" in parsed);
  const plan = (parsed as { plan: DeployPlan }).plan;
  assert.deepEqual(plan, { targets: [], noMigrate: false, extra: ["-e", "site_address=https://localhost"] });
});

test("an unknown flag before -- is refused rather than treated as a target", () => {
  const parsed = parseDeployArgs(["--bogus-flag"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /unknown flag/);
});

test("a flag's value is not swallowed as a target when -- is missing", () => {
  // Without a literal --, "-e" itself is refused rather than silently
  // becoming part of deploy_targets.
  const parsed = parseDeployArgs(["-e", "dns_check=false"]);
  assert.ok("error" in parsed);
});
