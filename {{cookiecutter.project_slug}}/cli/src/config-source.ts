// Reads settings out of the app's config.ts as text. The CLI is built
// separately from the app and cannot import its config, so this finds a
// setting by its path (`legal.dmcaAgent.phone`) in the source itself: enough
// for the plain object literal config.ts is, not a TypeScript parser.

const PLACEHOLDER_PREFIX = "REPLACE_WITH_";

/** The source text of the setting at `path` — a whole string literal, or an
 * expression up to the comma or line end that closes it — or null when
 * config.ts does not set it. Comments are ignored. */
export function readSetting(configSource: string, path: string): string | null {
  const keys = path.split(".");
  const last = keys.pop()!;
  let body = stripComments(configSource);
  for (const key of keys) body = objectBody(body, key);

  const value = String.raw`((["'\`])(?:\\.|(?!\2)[^\\])*\2|[^,\n]+)`;
  const match = topLevel(body).match(new RegExp(String.raw`(?:^|[\s,{])${last}\s*:\s*` + value));
  return match ? match[1].trim() : null;
}

/** True for a missing setting, an empty string or a REPLACE_WITH_ placeholder
 * (the same prefix lib/marketing-email.ts refuses to send with). A value given
 * as an expression (say, `process.env.X`) is not: this cannot tell. */
export function isPlaceholder(value: string | null): boolean {
  if (value === null) return true;
  const literal = value.match(/^(["'`])(.*)\1$/);
  if (!literal) return false;
  const text = literal[2].trim();
  return text === "" || text.startsWith(PLACEHOLDER_PREFIX);
}

/** The text inside the braces of the first `key: { ... }` in `source`, or ""
 * when there is no such object. */
function objectBody(source: string, key: string): string {
  const match = new RegExp(String.raw`(?:^|[\s,{])${key}\s*:\s*\{`).exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  return source.slice(start, matchingBrace(source, start));
}

/** `body` with every nested `{ ... }` blanked out, so a key lookup only sees
 * this level. String contents are kept as they are. */
function topLevel(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (isQuote(body[i])) {
      const end = stringEnd(body, i);
      out += body.slice(i, end + 1);
      i = end + 1;
    } else if (body[i] === "{") {
      const end = matchingBrace(body, i + 1);
      out += " ".repeat(end + 1 - i);
      i = end + 1;
    } else {
      out += body[i];
      i += 1;
    }
  }
  return out;
}

/** `source` with its comments removed, string literals left as they are, so
 * a comment mentioning a setting cannot be read as the setting. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (isQuote(source[i])) {
      const end = stringEnd(source, i);
      out += source.slice(i, end + 1);
      i = end + 1;
    } else if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

/** Index of the "}" closing a brace opened just before `from`, skipping
 * braces inside string literals. The end of `source` if none. */
function matchingBrace(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length; i += 1) {
    if (isQuote(source[i])) {
      i = stringEnd(source, i);
    } else if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

/** End of the string literal opening at `start`: the index of its closing quote. */
function stringEnd(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length && source[i] !== source[start]) i += source[i] === "\\" ? 2 : 1;
  return i;
}
