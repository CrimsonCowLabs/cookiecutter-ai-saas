import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
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
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts as any,
    sessionsTable: sessions as any,
    verificationTokensTable: verificationTokens as any,
  }),
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
