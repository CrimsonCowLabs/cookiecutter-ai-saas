// Reading a Content-Security-Policy header, for tests/csp/policy.test.mjs
// (the policy lib/csp.ts builds) and tests/compliance/
// content-security-policy.test.mjs (the one a running app sends).

/** The policy in `header` as { directive: [values] }. */
export function parsePolicy(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...values]) => [name, values])
  );
}
