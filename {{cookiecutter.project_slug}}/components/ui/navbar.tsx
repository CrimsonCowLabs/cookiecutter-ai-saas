import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { MenuIcon } from "@/components/ui/icons";

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

// Single source of truth for both the desktop nav and the mobile dropdown
// below, so a link only has to be added/removed/renamed once. `anchor: true`
// means an in-page `#hash` scroll target (plain <a>), anything else is a
// real route (next/link <Link>). The marker comments below each wrap one
// whole array entry — post_gen_project.py's marker stripper deletes entire
// lines, the same pattern already used by baseNavItems in the dashboard
// layout. (Note for future edits here: avoid writing those two marker
// keywords together as plain prose in a comment — followed by a space and a
// word, "the closing one" reads as a real end-marker to that line-based
// stripper and the whole comment line gets silently deleted.)
const NAV_LINKS: { href: string; label: string; anchor?: boolean }[] = [
  { href: "#features", label: "Features", anchor: true },
  { href: "#pricing", label: "Pricing", anchor: true },
  // cc:begin blog
  { href: "/blog", label: "Blog" },
  // cc:end blog
  // cc:begin contact
  { href: "/contact", label: "Contact" },
  // cc:end contact
];

function NavLink({
  href,
  label,
  anchor,
  className,
}: {
  href: string;
  label: string;
  anchor?: boolean;
  className?: string;
}) {
  return anchor ? (
    <a href={href} className={className}>
      {label}
    </a>
  ) : (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}

interface NavbarProps {
  isAuthenticated?: boolean;
}

export function Navbar({ isAuthenticated }: NavbarProps) {
  const cta = isAuthenticated ? (
    <Link href="/dashboard" className="btn btn-sm btn-primary gap-1">
      Dashboard
      <ArrowRight className="w-3.5 h-3.5" />
    </Link>
  ) : (
    <Link href="/sign-up" className="btn btn-sm btn-primary gap-1">
      Get Started
      <ArrowRight className="w-3.5 h-3.5" />
    </Link>
  );

  return (
    <header className="sticky top-0 z-50 border-b border-base-content/5 bg-base-100/80 backdrop-blur-xl">
      <nav className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2 group">
          <Logo className="h-6 w-6 text-primary transition-transform group-hover:scale-110" />
          <span className="font-bold text-lg tracking-tight">
            __PROJECT_NAME__
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-8 text-sm text-base-content/60">
          {NAV_LINKS.map((link) => (
            <NavLink key={link.href} {...link} className="hover:text-base-content transition-colors" />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {cta}

          {/* Mobile nav: a native <details>/<summary> disclosure needs no
              client JS and works with keyboard/screen readers out of the
              box, unlike a useState-driven toggle. */}
          <details className="dropdown dropdown-end md:hidden">
            <summary
              className="btn btn-square btn-ghost [&::-webkit-details-marker]:hidden"
              style={{ listStyle: "none" }}
              aria-label="Open menu"
            >
              <MenuIcon className="w-5 h-5" />
            </summary>
            <ul className="menu dropdown-content z-50 mt-3 w-48 rounded-box border border-base-content/10 bg-base-100 p-2 shadow-lg text-sm text-base-content/80">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <NavLink {...link} />
                </li>
              ))}
            </ul>
          </details>
        </div>
      </nav>
    </header>
  );
}
