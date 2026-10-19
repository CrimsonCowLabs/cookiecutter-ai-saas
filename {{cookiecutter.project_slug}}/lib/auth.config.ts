import type { NextAuthConfig } from "next-auth";
// cc:begin google-import
import Google from "next-auth/providers/google";
// cc:end google-import
// cc:begin microsoft-import
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
// cc:end microsoft-import
// cc:begin magic-link
import Resend from "next-auth/providers/resend";
import config from "@/config";
// cc:end magic-link

const isDev = process.env.NODE_ENV === "development";

/**
 * OAuth providers that work in Edge Runtime (no adapter needed).
 */
const oauthProviders = [
  // cc:begin google
  Google({
    clientId: process.env.GOOGLE_ID!,
    clientSecret: process.env.GOOGLE_SECRET!,
    // Unset in production, so Google's own issuer applies. The compliance
    // suite points it at a stand-in sign-in server
    // (tests/compliance/fake-oidc.mjs) to sign up through Google for real.
    issuer: process.env.AUTH_GOOGLE_ISSUER,
    // NOTE: this lets a Google sign-in adopt an existing account with the same
    // verified email (e.g. one created by magic link). Convenient, but it means
    // the OAuth provider's email verification is trusted. Set to false if your
    // app holds sensitive data.
    allowDangerousEmailAccountLinking: true,
  }),
  // cc:end google
  // cc:begin microsoft
  MicrosoftEntraID({
    clientId: process.env.MICROSOFT_ENTRA_ID_ID!,
    clientSecret: process.env.MICROSOFT_ENTRA_ID_SECRET!,
    // AUTH_MICROSOFT_ENTRA_ID_ISSUER is unset in production; the compliance
    // suite sets it, as AUTH_GOOGLE_ISSUER above.
    // MICROSOFT_ENTRA_ID_TENANT_ID blank means "common": anyone with a work,
    // school or personal Microsoft account, from any tenant, can sign in.
    issuer:
      process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER ||
      (process.env.MICROSOFT_ENTRA_ID_TENANT_ID
        ? `https://login.microsoftonline.com/${process.env.MICROSOFT_ENTRA_ID_TENANT_ID}/v2.0`
        : "https://login.microsoftonline.com/common/v2.0"),
    // NOTE: unlike Google's, Entra's email claim is whatever a tenant's admin
    // typed in, and nothing verifies it. Linking on it alone would let anyone
    // with a tenant of their own sign in as any existing user ("nOAuth"), so
    // the signIn callback in lib/auth.ts allows it only when the ID token
    // proves the email (lib/account-linking.ts): Microsoft verified its
    // domain (the xms_edov optional claim, which you add to the app
    // registration's ID token), or the sign-in is by a member (not a guest)
    // of the one tenant MICROSOFT_ENTRA_ID_TENANT_ID names. Otherwise an existing user signs in
    // the way they first did. Set this to false to never link Microsoft
    // sign-ins by email at all.
    allowDangerousEmailAccountLinking: true,
  }),
  // cc:end microsoft
];

// cc:begin magic-link
/**
 * Email provider (requires adapter, cannot be used in Edge).
 */
export const emailProvider = Resend({
  apiKey: process.env.RESEND_API_KEY,
  from: config.resend.fromNoReply,
  sendVerificationRequest: isDev
    ? async ({ identifier: email, url }) => {
        console.log("\n" + "=".repeat(60));
        console.log("MAGIC LINK (dev mode)");
        console.log("=".repeat(60));
        console.log(`Email: ${email}`);
        console.log(`URL:   ${url}`);
        console.log("=".repeat(60) + "\n");
      }
    : undefined,
});
// cc:end magic-link

/**
 * Base auth configuration for Edge Runtime (middleware).
 * Only includes OAuth providers - NO email provider (requires adapter).
 */
export const authConfig: NextAuthConfig = {
  debug: isDev,
  // Auth.js v5 refuses to infer its own origin unless it is told to trust the
  // Host header, and returns 500 UntrustedHost on every /api/auth/* request in
  // production. That is correct for unknown hosts, but these apps are
  // self-hosted behind a reverse proxy that sets Host, with NEXTAUTH_URL pinned
  // below. Without this, auth works in `next dev` and is broken in Docker.
  trustHost: true,
  providers: oauthProviders,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    authorized: ({ auth }) => {
      return !!auth?.user;
    },
    jwt: async ({ token, user, account }) => {
      if (user) {
        token.id = user.id;
      }
      if (account) {
        token.provider = account.provider;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (session?.user && token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/sign-in",
    // cc:begin magic-link
    verifyRequest: "/magic-link",
    // cc:end magic-link
    error: "/sign-in",
  },
};
