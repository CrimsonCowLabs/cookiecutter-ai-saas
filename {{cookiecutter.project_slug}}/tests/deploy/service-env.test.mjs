// Each production container is handed only the settings its own code reads.
//
// ansible/deploy.yml renders one env file per service (ansible/templates/
// env-<service>.j2), and docker-compose.prod.yml gives each service its own.
// The point is containment: the worker runs a model's tool calls against URLs
// a user supplied, and whatever is in its environment is what a successful
// prompt injection or a bug in a fetcher walks away with. Before the split,
// that was the Stripe secret key, NEXTAUTH_SECRET (enough to forge anybody's
// session), the OAuth client secrets and the database password, none of which
// the worker reads.
//
// So this holds each env file to the code that runs in its container, in both
// directions:
//
//   * every name a service's file sets is read by that service's code, so a
//     secret cannot be handed to a service "in case" — the failure names the
//     service and the variable;
//   * every name a service's code reads that the deploy renders for anybody is
//     in that service's own file, so splitting the file cannot quietly leave a
//     service without a setting it used to get from the shared one.
//
// "Reads" is found by scanning source for the literal forms the project uses:
// process.env.NAME and process.env["NAME"] in TypeScript and JavaScript, and
// os.getenv("NAME"), os.environ.get("NAME"), os.environ["NAME"] and the
// worker's own _env("NAME") / _flag("NAME") in Python. A read whose name is
// not a literal (process.env[flag]) cannot be scanned, so it fails here unless
// DYNAMIC_READS says how to resolve it — which is what keeps a new dynamic
// read from making the check silently blind to it.
//
// No server, no database, no build: `npm run test:deploy`. It reads the
// generated tree as it is, so it holds whichever flags it was generated with.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATES = "ansible/templates";

// Every container that gets an env file, with the template deploy.yml renders
// it from and the code that runs inside it. `compose` is false for the
// migrator, which deploy.yml starts with `docker run`, not through compose.
//
// ops's code is lib/db, not all of lib/: the ops image carries lib/ so that an
// ad hoc `docker compose run ops ...` can import the schema and talk to the
// database as the app role, which is all it is for. The rest of lib/ is the
// app's, and reading it as ops's would hand ops the app's secrets on the
// grounds that its image happens to contain the files.
export const SERVICES = {
  app: {
    template: "env-app.j2",
    code: ["app", "lib", "components", "hooks", "types", "config.ts", "middleware.ts", "next.config.ts"],
    compose: true,
  },
  worker: { template: "env-worker.j2", code: ["workers/app"], compose: true },
  "db-writer": { template: "env-db-writer.j2", code: ["workers/db-writer"], compose: true },
  ops: { template: "env-ops.j2", code: ["lib/db"], compose: true },
  migrator: { template: "env-migrations.j2", code: ["drizzle.config.ts"], compose: false },
};

// The compose file's own variables: what `docker compose --env-file
// .env-production` interpolates into the postgres and caddy services. No
// container is handed this file.
const COMPOSE_ENV_TEMPLATE = "env-production.j2";

// Reads whose name is computed, by file, and how to find the names. A file
// listed here with a resolver returning [] is one whose dynamic access is not
// a read of a setting (a helper whose callers pass literals the scan sees).
const DYNAMIC_READS = {
  // isFeatureEnabled(flag) reads process.env[flag] for each key of FLAGS.
  "lib/feature-flags.ts": (src) => [...src.matchAll(/^\s+(FEATURE_[A-Z0-9_]+)\s*:/gm)].map((m) => m[1]),
  // _env(key) is the one os.getenv call; its callers pass literal names.
  "workers/app/settings.py": () => [],
};

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "tests", "__pycache__", ".venv"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function sourceFiles(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return SOURCE_EXT.has(path.extname(rel)) ? [rel] : [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .filter((e) => !e.name.includes(".test."))
    .flatMap((e) => sourceFiles(path.join(rel, e.name)));
}

/** The environment variables one source file reads: { names, dynamic }. */
export function scanSource(src, ext) {
  if (ext === ".py") {
    const code = src.replace(/^\s*#.*$/gm, "");
    const names = [
      ...code.matchAll(/\b(?:_env|_flag|os\.getenv|os\.environ\.get)\(\s*["']([A-Z][A-Z0-9_]*)["']/g),
      ...code.matchAll(/\bos\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g),
    ].map((m) => m[1]);
    const dynamic = /\bos\.(?:getenv|environ\.get)\(\s*(?!["'])|\bos\.environ\[\s*(?!["'])/.test(code);
    return { names, dynamic };
  }
  // Comments that start a line only: a `/*` or `//` inside a string (a glob,
  // a URL) is not one.
  const code = src.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
  const names = [
    ...code.matchAll(/\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g),
    ...code.matchAll(/\bprocess\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g),
  ].map((m) => m[1]);
  // Anything else done with process.env: an index by a variable, a spread, an
  // alias. NODE_ENV-style lowercase property names are not settings and are
  // not expected, so they count as dynamic too.
  const dynamic = /\bprocess\.env(?!\.[A-Z_][A-Z0-9_]*\b|\[\s*["'`][A-Z_][A-Z0-9_]*["'`]\s*\])/.test(code);
  return { names, dynamic };
}

/** Every name a service's code reads, and the files with unresolved dynamic reads. */
function codeReads(service) {
  const names = new Set();
  const unresolved = [];
  for (const file of SERVICES[service].code.flatMap(sourceFiles)) {
    const src = read(file);
    const found = scanSource(src, path.extname(file));
    found.names.forEach((n) => names.add(n));
    if (found.dynamic) {
      const resolve = DYNAMIC_READS[file.split(path.sep).join("/")];
      if (resolve) resolve(src).forEach((n) => names.add(n));
      else unresolved.push(file);
    }
  }
  return { names, unresolved };
}

/** The names an env template sets: NAME=... lines, and the proxy's (NAME, value) pairs. */
export function templateNames(src) {
  const text = src.replace(/\{#[\s\S]*?#\}/g, "");
  return new Set([
    ...[...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    ...[...text.matchAll(/\(\s*'([A-Z][A-Z0-9_]*)'\s*,/g)].map((m) => m[1]),
  ]);
}

const envNames = (template) => templateNames(read(path.join(TEMPLATES, template)));

/** service -> its env_file entries, from the compose file's services block. */
function composeEnvFiles(src) {
  const services = {};
  let current = null;
  let inServices = false;
  for (const line of src.split("\n")) {
    if (/^\S/.test(line)) inServices = /^services:\s*$/.test(line);
    if (!inServices) continue;
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      current = header[1];
      services[current] = [];
      continue;
    }
    const envFile = current && line.match(/^ {4}env_file:\s*(\S.*?)\s*$/);
    if (envFile) services[current].push(envFile[1]);
  }
  return services;
}

// ── The scanner itself ──────────────────────────────────────────────────────

test("the scanner finds literal reads and notices computed ones", () => {
  const ts = scanSource(
    [
      "const a = process.env.STRIPE_SECRET_KEY;",
      'const b = process.env["REDIS_URL"];',
      "// process.env.IN_A_COMMENT is not a read",
    ].join("\n"),
    ".ts",
  );
  assert.deepEqual(ts.names.sort(), ["REDIS_URL", "STRIPE_SECRET_KEY"]);
  assert.equal(ts.dynamic, false);
  assert.equal(scanSource("const v = process.env[flag];", ".ts").dynamic, true);
  assert.equal(scanSource("const env = { ...process.env };", ".ts").dynamic, true);

  const py = scanSource(
    [
      'a = os.getenv("OPENAI_API_KEY")',
      "b = os.environ.get('REDIS_URL', 'x')",
      'c = os.environ["LLM_PROVIDER"]',
      'd = _env("LANGSMITH_API_KEY")',
      'e = _flag("LANGSMITH_TRACING")',
      '# os.getenv("IN_A_COMMENT")',
    ].join("\n"),
    ".py",
  );
  assert.deepEqual(py.names.sort(), [
    "LANGSMITH_API_KEY",
    "LANGSMITH_TRACING",
    "LLM_PROVIDER",
    "OPENAI_API_KEY",
    "REDIS_URL",
  ]);
  assert.equal(py.dynamic, false);
  assert.equal(scanSource("v = os.getenv(key)", ".py").dynamic, true);
});

test("a template's names are its NAME= lines and the proxy's pairs, not its comments", () => {
  const names = templateNames(
    [
      "# NOT_THIS=because it is a comment",
      "{# NOR_THIS=inside a Jinja comment #}",
      "DATABASE_URL=postgresql://...",
      "{% set proxy_env = [('SITE_ADDRESS', site_address)] %}",
    ].join("\n"),
  );
  assert.deepEqual([...names].sort(), ["DATABASE_URL", "SITE_ADDRESS"]);
});

// ── The env files against the code ──────────────────────────────────────────

for (const [service, { template }] of Object.entries(SERVICES)) {
  test(`${service}: ${template} exists`, () => {
    assert.ok(fs.existsSync(path.join(ROOT, TEMPLATES, template)), `${TEMPLATES}/${template} is missing`);
  });

  test(`${service}: every computed environment read can be resolved`, () => {
    const { unresolved } = codeReads(service);
    assert.deepEqual(
      unresolved,
      [],
      `these files read process.env / os.environ with a computed name, which this check cannot see; ` +
        `read the names literally or teach DYNAMIC_READS in ${path.relative(ROOT, fileURLToPath(import.meta.url))} how to find them`,
    );
  });

  test(`${service}: is given nothing its code does not read`, () => {
    const given = envNames(template);
    const { names } = codeReads(service);
    const extra = [...given].filter((n) => !names.has(n)).sort();
    assert.deepEqual(
      extra,
      [],
      `${TEMPLATES}/${template} gives ${service} ${extra.join(", ")}, which nothing in ` +
        `${SERVICES[service].code.join(", ")} reads. Take it out of ${service}'s file, or read it there.`,
    );
  });

  test(`${service}: is given every rendered setting its code reads`, () => {
    const rendered = new Set(
      [...Object.values(SERVICES).map((s) => s.template), COMPOSE_ENV_TEMPLATE].flatMap((t) => [...envNames(t)]),
    );
    const given = envNames(template);
    const { names } = codeReads(service);
    const missing = [...names].filter((n) => rendered.has(n) && !given.has(n)).sort();
    assert.deepEqual(
      missing,
      [],
      `${service} reads ${missing.join(", ")}, which the deploy renders for another service but not into ` +
        `${TEMPLATES}/${template}.`,
    );
  });
}

test("the worker holds no Stripe, NextAuth, OAuth or database credential", () => {
  // Redundant with "given nothing its code does not read" today, and here so
  // that it stays true when somebody adds a read to the worker: these are the
  // secrets whose loss would hand over the account rather than the worker.
  const forbidden = /^(STRIPE_|NEXTAUTH_|AUTH_|GOOGLE_|MICROSOFT_ENTRA_ID_|RESEND_|POSTGRES_|DATABASE_URL$)/;
  const leaked = [...envNames(SERVICES.worker.template)].filter((n) => forbidden.test(n));
  assert.deepEqual(leaked, [], `the worker's env file carries ${leaked.join(", ")}`);
});

// ── The env files against the compose file and the playbook ─────────────────

test("each compose service is handed its own env file, and none is handed .env-production", () => {
  const envFiles = composeEnvFiles(read("docker-compose.prod.yml"));
  const expected = Object.fromEntries(
    Object.entries(SERVICES)
      .filter(([, s]) => s.compose)
      .map(([name]) => [name, [`.env-${name}`]]),
  );
  const actual = Object.fromEntries(Object.entries(envFiles).filter(([, files]) => files.length > 0));
  assert.deepEqual(actual, expected);
});

test("deploy.yml renders an env file for exactly the compose services that use one", () => {
  const match = read("ansible/deploy.yml").match(/^\s*service_env_files:\s*\[([^\]]*)\]/m);
  assert.ok(match, "ansible/deploy.yml has no `service_env_files: [...]`");
  const rendered = match[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
  const expected = Object.entries(SERVICES)
    .filter(([, s]) => s.compose)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(rendered, expected);
});

test(".env-production holds only what the compose file itself interpolates", () => {
  const compose = read("docker-compose.prod.yml");
  const interpolated = new Set([
    ...[...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
    // `- NAME` under `environment:` passes the value through from the same place.
    ...[...compose.matchAll(/^\s+- ([A-Z][A-Z0-9_]*)\s*$/gm)].map((m) => m[1]),
  ]);
  const extra = [...envNames(COMPOSE_ENV_TEMPLATE)].filter((n) => !interpolated.has(n)).sort();
  assert.deepEqual(extra, [], `${TEMPLATES}/${COMPOSE_ENV_TEMPLATE} sets ${extra.join(", ")}, which no compose service reads`);
});
