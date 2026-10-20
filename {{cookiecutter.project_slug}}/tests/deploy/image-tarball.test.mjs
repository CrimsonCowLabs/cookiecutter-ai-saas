// The images a deploy ships cross the wire as one tarball, and nobody else on
// either machine gets to read it.
//
// ansible/deploy.yml `docker save`s every image the host is missing into one
// gzipped tarball on the control machine, copies it to the host and `docker
// load`s it there. That tarball is the whole release: the app's built code,
// the worker's, and anything a build step happened to leave in a layer. It
// used to be written to a fixed name under /tmp on both machines, with the
// umask's permissions — world-readable on a typical system — and removed only
// by the last two tasks, so a save, copy or load that failed left it behind on
// both sides for anyone with a shell to read.
//
// What this holds the playbook to:
//
//   * nothing in it names a fixed path under a world-shared temp directory
//     (/tmp, /var/tmp, /dev/shm), so the tarball cannot go back there;
//   * the tarball is written inside a directory `ansible.builtin.tempfile`
//     made — mkdtemp, so 0700 and a name nobody can predict — one on the
//     control machine and one on the host, and the playbook refuses to go on
//     unless both really are 0700;
//   * the save, the copy and the load are in the same `block:` as the two
//     directories, and that block's `always:` removes both, so a failure
//     anywhere in between still cleans up;
//   * the block runs only when an image is missing, so an unchanged deploy
//     makes no directory at all and still reports no change.
//
// There is no YAML parser among the project's dependencies, and this does not
// add one for a single file. deploy.yml is written in one consistent style —
// two-space indentation, every task starting `- name:` — so tasks are found by
// their indentation, which is all the structure the checks need.
//
// No server, no Docker, no Ansible: `npm run test:deploy`. That the
// directories are really removed, after a deploy that worked and after one
// whose load failed, is scripts/check_deploy.sh's to show against a real host.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLAYBOOK = fs.readFileSync(path.join(ROOT, "ansible/deploy.yml"), "utf8");

const indentOf = (line) => line.length - line.trimStart().length;
const isComment = (line) => /^\s*#/.test(line);

/**
 * Every task in a playbook: its name, indentation, its own lines (comments
 * dropped, nested tasks included — `leaf` is false when there are any), and
 * where it sits — the `block:`, `rescue:` or `always:` it is listed under,
 * and the task that section belongs to.
 */
export function tasks(src) {
  const lines = src.split("\n");
  const found = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)- name: (.*)$/);
    if (!m) return;
    const indent = m[1].length;
    const body = [line.replace(/^(\s*)- /, "$1  ")];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === "" || isComment(next)) continue;
      if (indentOf(next) <= indent) break;
      body.push(next);
    }
    // The line this task is listed under is the nearest one above it that is
    // indented less: a section keyword, or `tasks:` for a top-level task.
    let section = null;
    let parent = null;
    for (let j = i - 1; j >= 0; j--) {
      const above = lines[j];
      if (above.trim() === "" || isComment(above) || indentOf(above) >= indent) continue;
      const key = above.match(/^(\s*)(block|rescue|always):\s*$/);
      if (key) {
        section = key[2];
        parent = found.findLast((t) => t.indent < key[1].length && t.line < j) ?? null;
      }
      break;
    }
    const text = body.join("\n");
    const leaf = !text.slice(text.indexOf("\n") + 1).includes("- name:");
    found.push({ name: m[2].trim(), indent, line: i, text, leaf, section, parent });
  });
  return found;
}

/** A task's own value for a key, at the indentation of its keys: `when: ...`. */
function own(task, key) {
  const pad = " ".repeat(task.indent + 2);
  const m = task.text.match(new RegExp(`^${pad}${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

/** A module argument of a task, at whatever depth it is written: `src: ...`. */
function arg(task, key) {
  const m = task.text.match(new RegExp(`^\\s+${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

/** Variables the playbook sets with `name: "value"`, by name, for following one back to what it is. */
function definitions(src) {
  const defs = {};
  for (const m of src.matchAll(/^\s+([a-z_][a-z0-9_]*):\s*"([^"]*)"\s*$/gm)) defs[m[1]] ??= m[2];
  return defs;
}

/** An expression with every variable it names that is set to a string replaced by that string. */
function expand(expr, defs, depth = 0) {
  if (depth > 5) return expr;
  return expr.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*(\|[^}]*)?\}\}/g, (whole, name) =>
    name in defs ? expand(defs[name], defs, depth + 1) : whole,
  );
}

const ALL = tasks(PLAYBOOK);
const DEFS = definitions(PLAYBOOK);

/** The tempfile tasks that make a directory, with what they register and where they run. */
function privateDirs() {
  return ALL.filter((t) => t.leaf && /ansible\.builtin\.tempfile:/.test(t.text) && /state:\s*directory/.test(t.text)).map(
    (t) => ({ task: t, register: own(t, "register"), local: own(t, "delegate_to") === "localhost" }),
  );
}

const byCommand = (re, what) => {
  const task = ALL.find((t) => t.leaf && re.test(t.text));
  assert.ok(task, `ansible/deploy.yml has no task that ${what}`);
  return task;
};
const saveTask = () => byCommand(/docker save/, "runs `docker save`");
const copyTask = () => byCommand(/ansible\.builtin\.copy:[\s\S]*src:[^\n]*tar/, "copies the tarball to the host");
const loadTask = () => byCommand(/docker load/, "runs `docker load`");

test("the task finder sees sections and the task they belong to", () => {
  const src = [
    "  tasks:",
    "    - name: Outer",
    "      when: x",
    "      block:",
    "        - name: Inner",
    "          # a comment",
    "          ansible.builtin.debug:",
    "      always:",
    "        - name: Cleanup",
    "          ansible.builtin.file:",
    "    - name: After",
  ].join("\n");
  const found = tasks(src);
  assert.deepEqual(
    found.map((t) => [t.name, t.section, t.parent?.name ?? null]),
    [
      ["Outer", null, null],
      ["Inner", "block", "Outer"],
      ["Cleanup", "always", "Outer"],
      ["After", null, null],
    ],
  );
  assert.equal(own(found[0], "when"), "x");
  assert.ok(!found[1].text.includes("a comment"));
});

test("nothing in deploy.yml names a fixed path in a world-shared temp directory", () => {
  const code = PLAYBOOK.split("\n").filter((l) => !isComment(l));
  const shared = code.filter((l) => /(^|[\s"'=:])\/(tmp|var\/tmp|dev\/shm)(\/|["'\s]|$)/.test(l));
  assert.deepEqual(
    shared,
    [],
    "a fixed name in a shared temp directory is readable, or at least guessable, by every account on the machine; " +
      "write to a directory ansible.builtin.tempfile made instead",
  );
});

test("there is a private directory for the tarball on the control machine and on the host", () => {
  const dirs = privateDirs();
  const local = dirs.filter((d) => d.local);
  const remote = dirs.filter((d) => !d.local);
  assert.equal(local.length, 1, "expected one tempfile directory delegated to localhost, for the saved tarball");
  assert.equal(remote.length, 1, "expected one tempfile directory on the host, for the copied tarball");
  for (const d of dirs) assert.ok(d.register, `"${d.task.name}" registers nothing, so nothing can find the directory again`);

  // mkdtemp makes the directory 0700 today; the playbook checks rather than
  // relying on it, so a module that ever stopped doing so fails the deploy
  // instead of quietly sharing the release.
  const checked = ALL.filter((t) => t.leaf && /ansible\.builtin\.assert:/.test(t.text) && /0700/.test(t.text));
  for (const d of dirs) {
    assert.ok(
      checked.some((t) => new RegExp(`\\b${d.register}\\.mode\\s*==\\s*['"]0700['"]`).test(t.text)),
      `nothing asserts that ${d.register}.mode is 0700`,
    );
  }
});

test("the tarball is written, copied and loaded inside those directories", () => {
  const dirs = privateDirs();
  const localReg = dirs.find((d) => d.local)?.register;
  const hostReg = dirs.find((d) => !d.local)?.register;
  assert.ok(localReg && hostReg, "the private directories are missing; see the test above");

  const save = saveTask();
  assert.equal(own(save, "delegate_to"), "localhost", "the images are saved on the control machine");
  const dest = save.text.match(/>\s*(\{\{[^}]*\}\}|\S+)/);
  assert.ok(dest, "the save task does not redirect `docker save` into a file");
  assert.match(expand(dest[1], DEFS), new RegExp(`${localReg}\\.path\\b`), "the save writes outside the control machine's private directory");

  const copy = copyTask();
  assert.match(expand(arg(copy, "src") ?? "", DEFS), new RegExp(`${localReg}\\.path\\b`), "the copy's src is not the saved tarball");
  assert.match(expand(arg(copy, "dest") ?? "", DEFS), new RegExp(`${hostReg}\\.path\\b`), "the copy lands outside the host's private directory");

  const load = loadTask();
  assert.match(expand(load.text, DEFS), new RegExp(`${hostReg}\\.path\\b`), "the load reads a tarball outside the host's private directory");
});

test("both directories are removed in an always: section, so a failed save, copy or load still cleans up", () => {
  const dirs = privateDirs();
  const owner = dirs[0]?.task.parent;
  assert.ok(owner, "the private directories are not made inside a block");
  for (const t of [...dirs.map((d) => d.task), saveTask(), copyTask(), loadTask()]) {
    assert.equal(t.section, "block", `"${t.name}" is not in a block:`);
    assert.equal(t.parent, owner, `"${t.name}" is not in the same block as the private directories`);
  }

  const always = ALL.filter((t) => t.parent === owner && t.section === "always");
  for (const d of dirs) {
    const removal = always.find(
      (t) => /state:\s*absent/.test(t.text) && expand(arg(t, "path") ?? "", DEFS).includes(`${d.register}.path`),
    );
    assert.ok(removal, `nothing in the block's always: removes ${d.register}.path`);
    assert.equal(
      own(removal, "delegate_to") === "localhost",
      d.local,
      `"${removal.name}" removes ${d.register}.path on the wrong machine`,
    );
    // A tempfile task that itself failed registered no path; removing
    // "undefined" would turn one failure into two and hide the first.
    assert.match(own(removal, "when") ?? "", new RegExp(`${d.register}\\.path is defined`));
  }
  assert.ok(
    !ALL.some((t) => t.parent === owner && t.section === "rescue"),
    "a rescue: would swallow the failure; the deploy has to stop here with the previous release serving",
  );
});

test("an unchanged deploy makes no directory, so a re-run still reports no change", () => {
  const owner = privateDirs()[0]?.task.parent;
  assert.ok(owner, "the private directories are not made inside a block");
  assert.match(
    own(owner, "when") ?? "",
    /deploy_missing/,
    `"${owner.name}" runs whether or not an image is missing, and a temp directory made and removed is a change every time`,
  );
});
