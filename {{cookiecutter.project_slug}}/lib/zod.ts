/**
 * zod, set up to run under the Content-Security-Policy (lib/csp.ts). Import
 * `z` from here, never from "zod" itself (eslint.config.mjs enforces it).
 *
 * zod 4 compiles a fast parser for each object schema with `new Function`,
 * and tests whether it may by calling it once, as each schema is built. The
 * policy forbids eval in the browser, so that test is blocked and reported as
 * a violation on every page whose code defines a schema, even though zod
 * catches the error and falls back. `jitless` skips both the test and the
 * compiled parser. It has to be set before the first schema is built, which
 * is why it is set here, in the module every schema's file imports first.
 */
import { z } from "zod";

z.config({ jitless: true });

export { z };
