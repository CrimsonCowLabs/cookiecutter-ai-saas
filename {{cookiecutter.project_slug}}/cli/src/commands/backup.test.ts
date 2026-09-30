import { test } from "node:test";
import assert from "node:assert/strict";
import { backupServiceUnit } from "./backup";

test("backupServiceUnit follows ansible/backup.yml's own backup_name: app_dir's basename + -db-backup", () => {
  assert.equal(backupServiceUnit({ appDir: "/app/myapp" }), "myapp-db-backup");
});

test("backupServiceUnit uses app_dir's basename, not project_slug", () => {
  // group_vars/all.yml derives backup_name from app_dir, not project_slug —
  // this only matches the two cases they agree on, which is the point.
  assert.equal(backupServiceUnit({ appDir: "/srv/something-else" }), "something-else-db-backup");
});

test("backupServiceUnit tolerates a trailing slash", () => {
  assert.equal(backupServiceUnit({ appDir: "/app/myapp/" }), "myapp-db-backup");
});
