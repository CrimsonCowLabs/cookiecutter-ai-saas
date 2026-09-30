import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args";

test("no arguments means help", () => {
  assert.deepEqual(parseArgs([]), { command: null, isHelp: true, rest: [] });
});

test("help, --help and -h are all the help request", () => {
  for (const spelling of ["help", "--help", "-h"]) {
    assert.deepEqual(parseArgs([spelling]), { command: null, isHelp: true, rest: [] });
  }
});

test("a command name is passed through with the rest of argv untouched", () => {
  assert.deepEqual(parseArgs(["shell", "app", "bash", "-c", "ls"]), {
    command: "shell",
    isHelp: false,
    rest: ["app", "bash", "-c", "ls"],
  });
});

test("a bare command with no further args has an empty rest", () => {
  assert.deepEqual(parseArgs(["status"]), { command: "status", isHelp: false, rest: [] });
});
