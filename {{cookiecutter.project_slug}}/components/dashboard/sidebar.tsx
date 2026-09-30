import Link from "next/link";
import Image from "next/image";
import { Logo } from "@/components/brand/logo";

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

interface SidebarProps {
  navItems: NavItem[];
  userName?: string | null;
  userEmail?: string | null;
  userImage?: string | null;
  signOutAction: () => Promise<void>;
}

export function Sidebar({
  navItems,
  userName,
  userEmail,
  userImage,
  signOutAction,
}: SidebarProps) {
  return (
    <aside className="w-64 min-h-full bg-base-200 border-r border-base-300 flex flex-col">
      <div className="p-4 border-b border-base-300">
        <Link href="/dashboard" className="inline-flex items-center gap-2 font-bold text-xl">
          <Logo className="h-5 w-5 text-primary" />
          <span>__PROJECT_NAME__</span>
        </Link>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 min-h-11 px-3 py-2 rounded-lg hover:bg-base-300 transition-colors text-sm"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5 text-base-content/60"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
            </svg>
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="p-4 border-t border-base-300">
        <div className="flex items-center gap-3">
          {userImage && (
            <Image
              src={userImage}
              alt=""
              width={32}
              height={32}
              className="w-8 h-8 rounded-full"
            />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {userName ?? userEmail}
            </p>
          </div>
        </div>
        <form action={signOutAction} className="mt-3">
          <button type="submit" className="btn btn-outline min-h-11 w-full">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
