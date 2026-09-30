import Link from "next/link";
import { Logo } from "@/components/brand/logo";

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

interface NavbarProps {
  isAuthenticated?: boolean;
}

export function Navbar({ isAuthenticated }: NavbarProps) {
  const links = (
    <>
      <a href="#features" className="hover:text-base-content transition-colors">
        Features
      </a>
      <a href="#pricing" className="hover:text-base-content transition-colors">
        Pricing
      </a>
      {/* cc:begin blog */}
      <Link href="/blog" className="hover:text-base-content transition-colors">
        Blog
      </Link>
      {/* cc:end blog */}
      {/* cc:begin contact */}
      <Link href="/contact" className="hover:text-base-content transition-colors">
        Contact
      </Link>
      {/* cc:end contact */}
    </>
  );

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
          {links}
        </div>

        <div className="flex items-center gap-2">
          {cta}

          {/* Mobile nav: a native <details>/<summary> disclosure needs no
              client JS and works with keyboard/screen readers out of the
              box, unlike a useState-driven toggle. */}
          <details className="dropdown dropdown-end md:hidden">
            <summary
              className="btn btn-square btn-ghost min-h-11 min-w-11 [&::-webkit-details-marker]:hidden"
              style={{ listStyle: "none" }}
              aria-label="Open menu"
            >
              <MenuIcon className="w-5 h-5" />
            </summary>
            <ul className="menu dropdown-content z-50 mt-3 w-48 rounded-box border border-base-content/10 bg-base-100 p-2 shadow-lg text-sm text-base-content/80">
              <li>
                <a href="#features">Features</a>
              </li>
              <li>
                <a href="#pricing">Pricing</a>
              </li>
              {/* cc:begin blog */}
              <li>
                <Link href="/blog">Blog</Link>
              </li>
              {/* cc:end blog */}
              {/* cc:begin contact */}
              <li>
                <Link href="/contact">Contact</Link>
              </li>
              {/* cc:end contact */}
            </ul>
          </details>
        </div>
      </nav>
    </header>
  );
}
