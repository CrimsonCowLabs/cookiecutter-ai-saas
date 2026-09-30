import { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Sidebar } from "@/components/dashboard/sidebar";
import { DrawerAutoClose } from "@/components/dashboard/drawer-auto-close";
import { MenuIcon } from "@/components/ui/icons";
import config from "@/config";

const DRAWER_ID = "dashboard-drawer";

const baseNavItems = [
  { href: "/dashboard", label: "Overview", icon: "M2.25 12l8.954-8.955a1.125 1.125 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" },
  // cc:begin stripe
  { href: "/dashboard/settings", label: "Settings", icon: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
  // cc:end stripe
];

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  const session = await auth();

  if (!session) {
    redirect(config.auth.loginUrl);
  }

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { isAdmin: true },
  });
  const isAdmin = Boolean(currentUser?.isAdmin);

  const navItems = isAdmin
    ? [
        ...baseNavItems,
        {
          href: "/dashboard/admin",
          label: "Admin",
          icon: "M9 12.75 11.25 15 15 9.75m6 2.25c0 5.186-3.364 9.463-8.25 10.825C7.864 21.463 4.5 17.186 4.5 12V5.904a1.125 1.125 0 01.75-1.06 20.902 20.902 0 016.75-1.089c2.381 0 4.656.396 6.75 1.089.444.147.75.562.75 1.06V12z",
        },
      ]
    : baseNavItems;

  return (
    <div className="drawer md:drawer-open min-h-screen bg-base-100">
      {/* Checkbox-driven drawer: pure CSS below `md` (no client JS needed,
          same approach as the public navbar's mobile menu), and pinned open
          as a static sidebar at `md` and up via `md:drawer-open`. */}
      <input id={DRAWER_ID} type="checkbox" className="drawer-toggle" />
      <DrawerAutoClose drawerId={DRAWER_ID} />

      <div className="drawer-content flex flex-col">
        {/* Mobile topbar: the sidebar itself is off-canvas below `md`, so
            this is the only way to reach navigation/sign-out on a phone. */}
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-3 md:hidden">
          <label
            htmlFor={DRAWER_ID}
            aria-label="Open menu"
            className="btn btn-square btn-ghost"
          >
            <MenuIcon className="w-5 h-5" />
          </label>
          <Link href="/dashboard" className="font-bold">
            __PROJECT_NAME__
          </Link>
        </div>

        <main className="flex-1 overflow-auto">
          <div className="max-w-6xl mx-auto p-6">
            {children}
          </div>
        </main>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor={DRAWER_ID} aria-label="Close menu" className="drawer-overlay"></label>
        <Sidebar
          navItems={navItems}
          userName={session.user?.name}
          userEmail={session.user?.email}
          userImage={session.user?.image}
          signOutAction={handleSignOut}
        />
      </div>
    </div>
  );
}
