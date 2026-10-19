import NextAuth, { type Account, type User } from "next-auth";
import type { AdapterUser } from "next-auth/adapters";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { readAgeCheck } from "@/lib/age-check";
// cc:begin microsoft
import { mayLinkByEmail } from "@/lib/account-linking";
// cc:end microsoft
import {
  users,
  accounts,
  sessions,
  verificationTokens,
  auditLogs,
} from "@/lib/db/schema";
import { authConfig } from "./auth.config";
// cc:begin magic-link
import { emailProvider } from "./auth.config";
// cc:end magic-link

const adapter = DrizzleAdapter(db, {
  usersTable: users,
  accountsTable: accounts as any,
  sessionsTable: sessions as any,
  verificationTokensTable: verificationTokens as any,
});

/**
 * Which existing account this sign-in is for: "linked" when the provider's
 * account is already linked to a user, "email" when it isn't but a user has
 * its email (a magic link for a known address, or an OAuth sign-in Auth.js
 * will link to that user — see allowDangerousEmailAccountLinking in
 * lib/auth.config.ts), or null for a new account.
 */
async function existingAccount(
  user: User | AdapterUser,
  account?: Account | null
): Promise<"linked" | "email" | null> {
  if (account && account.type !== "email") {
    const [linked] = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, account.provider),
          eq(accounts.providerAccountId, account.providerAccountId)
        )
      )
      .limit(1);
    if (linked) return "linked";
  }
  if (!user.email) return null;
  const [byEmail] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, user.email))
    .limit(1);
  return byEmail ? "email" : null;
}

/** The age screen, with the destination the visitor was signing in for. */
async function ageScreenUrl() {
  const jar = await cookies();
  const callbackUrl =
    jar.get("__Secure-authjs.callback-url")?.value ?? jar.get("authjs.callback-url")?.value;
  const params = new URLSearchParams({ age_check: "required" });
  try {
    if (callbackUrl) {
      const { pathname, search } = new URL(callbackUrl, "http://placeholder");
      // Only ever a path on this site: "//host" would leave it.
      if (!pathname.startsWith("//")) params.set("callbackUrl", pathname + search);
    }
  } catch {
    // Not a URL; sign up lands on the default destination instead.
  }
  return `/sign-up?${params}`;
}

/**
 * Full auth configuration with database adapter.
 * Use this in server components and API routes (Node.js runtime).
 * Includes email provider which requires the adapter.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    // cc:begin magic-link
    // Email provider (requires adapter, only works in Node.js runtime)
    emailProvider,
    // cc:end magic-link
  ],
  adapter: {
    ...adapter,
    // The second lock on the age gate (the signIn callback below is the
    // first), and where the account records when the check was passed.
    createUser: async (user) => {
      const ageCheck = readAgeCheck(await cookies());
      if (ageCheck.status !== "passed") {
        throw new Error("Refusing to create an account without a passed age check");
      }
      return adapter.createUser!({ ...user, ageCheckPassedAt: ageCheck.passedAt } as AdapterUser);
    },
  },
  callbacks: {
    ...authConfig.callbacks,
    // The age gate (see lib/age-check.ts and docs/compliance.md). Every
    // provider's sign-in passes through here before Auth.js creates an
    // account: an OAuth callback, a magic-link request and opening the link.
    // An existing account always signs in. A new one is sent to the age
    // screen unless the visitor has passed it and not been turned away.
    signIn: async ({
      user,
      account,
      // cc:begin microsoft
      profile,
      // cc:end microsoft
    }) => {
      const existing = await existingAccount(user, account);
      // cc:begin microsoft
      // Linking by email is only as good as the provider's word for the
      // email, and Microsoft's isn't always good (see lib/account-linking.ts):
      // without proof, a Microsoft sign-in with someone's email is refused
      // rather than signed in as them. Auth.js's own error for this, which
      // the sign-in page explains.
      if (
        existing === "email" &&
        account &&
        !mayLinkByEmail(account.provider, profile, process.env.MICROSOFT_ENTRA_ID_TENANT_ID)
      ) {
        return "/sign-in?error=OAuthAccountNotLinked";
      }
      // cc:end microsoft
      if (existing) return true;
      if (readAgeCheck(await cookies()).status === "passed") return true;
      return ageScreenUrl();
    },
  },
  events: {
    createUser: async ({ user }) => {
      if (user.id) {
        await db.insert(auditLogs).values({
          userId: user.id,
          action: "user.created",
          resourceType: "user",
          resourceId: user.id,
          metadata: { email: user.email },
        });
      }
    },
    signIn: async ({ user, account, isNewUser }) => {
      if (user.id) {
        await db.insert(auditLogs).values({
          userId: user.id,
          action: isNewUser ? "user.first_sign_in" : "user.sign_in",
          resourceType: "session",
          metadata: {
            provider: account?.provider,
            isNewUser,
          },
        });

        await db
          .update(users)
          .set({ updatedAt: new Date() })
          .where(eq(users.id, user.id));
      }
    },
    signOut: async (message) => {
      const userId =
        "session" in message
          ? message.session?.userId
          : message.token?.id;

      if (userId && typeof userId === "string") {
        await db.insert(auditLogs).values({
          userId,
          action: "user.sign_out",
          resourceType: "session",
        });
      }
    },
  },
});
