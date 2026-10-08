import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";
import { NextResponse } from "next/server";

/**
 * Edge-safe middleware using authConfig (no adapter/email provider).
 * Full auth with adapter is only used in Node.js API routes/server components.
 */
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;

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
  ];

  const isPublic =
    publicExactPaths.includes(pathname) ||
    publicPathPrefixes.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    );

  if (isPublic) {
    return NextResponse.next();
  }

  // Protect dashboard routes
  if (pathname.startsWith("/dashboard") && !req.auth) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
