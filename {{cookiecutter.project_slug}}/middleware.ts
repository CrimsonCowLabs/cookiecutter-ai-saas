import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";
import { NextResponse } from "next/server";
import { cspEnv, cspForRequest, CSP_REPORT_PATH } from "@/lib/csp";

/**
 * Edge-safe middleware using authConfig (no adapter/email provider).
 * Full auth with adapter is only used in Node.js API routes/server components.
 */
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Every response gets this request's Content-Security-Policy (lib/csp.ts),
  // with a nonce made for it alone. The request carries the policy on to
  // the page being rendered too: Next.js reads the nonce out of it and puts
  // it on each script it writes, which is the only way a script runs.
  const csp = cspForRequest(cspEnv());
  const withCsp = (res: NextResponse) => {
    res.headers.set(csp.name, csp.value);
    return res;
  };
  const next = () => {
    const headers = new Headers(req.headers);
    headers.set("x-nonce", csp.nonce);
    headers.set(csp.name, csp.value);
    return withCsp(NextResponse.next({ request: { headers } }));
  };

  // Public routes - no auth required.
  //
  // "/" must be matched exactly. As a `startsWith` prefix it matches every
  // pathname there is, which made the entire site public and left the guard
  // below unreachable — the dashboard was then protected only by its layout's
  // own auth() call, and any protected prefix added here would be silently
  // public. Prefixes are matched on a path boundary so that, say,
  // "/sign-upgrade" does not inherit "/sign-up"'s public status.
  const publicExactPaths = ["/"];
  const publicPathPrefixes = [
    "/sign-in",
    "/sign-up",
    // cc:begin magic-link
    "/magic-link",
    // cc:end magic-link
    "/blog",
    "/contact",
    "/privacy-policy",
    "/tos",
    "/legal",
    // cc:begin resend
    "/unsubscribe",
    "/api/unsubscribe",
    // cc:end resend
    // cc:begin analytics
    // The first-party analytics proxy (app/ingest/[...path]/route.ts).
    "/ingest",
    // cc:end analytics
    "/api/auth",
    "/api/webhook",
    // Where browsers report Content-Security-Policy violations.
    CSP_REPORT_PATH,
  ];

  const isPublic =
    publicExactPaths.includes(pathname) ||
    publicPathPrefixes.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    );

  if (isPublic) {
    return next();
  }

  // Protect dashboard routes
  if (pathname.startsWith("/dashboard") && !req.auth) {
    return withCsp(NextResponse.redirect(new URL("/sign-in", req.url)));
  }

  return next();
});

// Every page, so every page carries the policy. Static files under
// /_next/static and images are left out: a policy on them protects nothing.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
