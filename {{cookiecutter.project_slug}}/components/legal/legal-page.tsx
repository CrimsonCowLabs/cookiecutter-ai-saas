import { ReactNode } from "react";
import Link from "next/link";
import { Main } from "@/components/ui/skip-link";

/**
 * The shell every /legal page shares: the look of the Privacy Policy and
 * Terms pages, a way back to the hub, and the not-legal-advice notice.
 */
export function LegalPage({
  title,
  intro,
  back = { href: "/legal", label: "All legal pages" },
  children,
}: {
  title: string;
  intro: ReactNode;
  back?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <Main className="min-h-screen bg-base-100">
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <Link href={back.href} className="mb-8 inline-flex items-center gap-2 text-sm text-base-content/60 hover:text-base-content">
          <span>&larr;</span>
          {back.label}
        </Link>

        <div className="space-y-3">
          <p className="text-sm font-medium text-primary">__PROJECT_NAME__ Legal</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{title}</h1>
          <p className="text-base-content/80">{intro}</p>
        </div>

        <div className="mt-10 space-y-8 text-base-content/80">{children}</div>

        <p className="mt-12 border-t border-base-content/10 pt-6 text-sm text-base-content/60">
          This page describes how this app is built. It is not legal advice, and
          following it does not by itself make an app compliant with any law.
        </p>
      </div>
    </Main>
  );
}

/** "The risk" and "How this app handles it": the two parts of every topic page. */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-base-content">{title}</h2>
      {children}
    </section>
  );
}
