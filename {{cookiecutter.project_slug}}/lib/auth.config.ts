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
    issuer: process.env.MICROSOFT_ENTRA_ID_TENANT_ID
      ? `https://login.microsoftonline.com/${process.env.MICROSOFT_ENTRA_ID_TENANT_ID}/v2.0`
      : "https://login.microsoftonline.com/common/v2.0",
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
