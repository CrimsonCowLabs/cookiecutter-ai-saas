import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export function Footer() {
  return (
    <footer className="relative z-10 border-t border-base-content/5">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="md:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <Logo className="h-5 w-5 text-primary" />
              <span className="font-bold tracking-tight">
                __PROJECT_NAME__
              </span>
            </Link>
            <p className="text-sm text-base-content/40 mt-3">
              __PROJECT_DESCRIPTION__
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm text-base-content/50">
              <li>
                <a href="#features" className="hover:text-base-content transition-colors">Features</a>
              </li>
              <li>
                <a href="#pricing" className="hover:text-base-content transition-colors">Pricing</a>
              </li>
              {/* cc:begin blog */}
              <li>
                <Link href="/blog" className="hover:text-base-content transition-colors">Blog</Link>
              </li>
              {/* cc:end blog */}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-sm text-base-content/50">
              {/* cc:begin contact */}
              <li>
                <Link href="/contact" className="hover:text-base-content transition-colors">Contact</Link>
              </li>
              {/* cc:end contact */}
              <li>
                <Link href="/privacy-policy" className="hover:text-base-content transition-colors">Privacy Policy</Link>
              </li>
              <li>
                <Link href="/tos" className="hover:text-base-content transition-colors">Terms of Service</Link>
              </li>
              <li>
                <Link href="/legal" className="hover:text-base-content transition-colors">Legal</Link>
              </li>
            </ul>
          </div>

          {/* Account */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Account</h4>
            <ul className="space-y-2 text-sm text-base-content/50">
              <li>
                <Link href="/sign-in" className="hover:text-base-content transition-colors">Sign In</Link>
              </li>
              <li>
                <Link href="/sign-up" className="hover:text-base-content transition-colors">Sign Up</Link>
              </li>
              <li>
                <Link href="/dashboard" className="hover:text-base-content transition-colors">Dashboard</Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-base-content/5 mt-8 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-base-content/30">
            &copy; {new Date().getFullYear()} __PROJECT_NAME__. All rights reserved.
          </p>
          <p className="text-xs text-base-content/30">
            Built with Next.js, Tailwind CSS, and DaisyUI
          </p>
        </div>
      </div>
    </footer>
  );
}
