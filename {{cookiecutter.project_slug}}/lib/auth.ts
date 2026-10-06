import NextAuth, { type Account, type User } from "next-auth";
import type { AdapterUser } from "next-auth/adapters";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { readAgeCheck } from "@/lib/age-check";
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

/** Whether this sign-in is for an account that already exists. */
async function isExistingAccount(user: User | AdapterUser, account?: Account | null) {
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
    if (linked) return true;
  }
  // A magic link for a known address, or an OAuth sign-in Auth.js will link
  // to the account with that address (see allowDangerousEmailAccountLinking
  // in lib/auth.config.ts).
  if (!user.email) return false;
  const [byEmail] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, user.email))
    .limit(1);
  return !!byEmail;
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
    signIn: async ({ user, account }) => {
      if (await isExistingAccount(user, account)) return true;
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
