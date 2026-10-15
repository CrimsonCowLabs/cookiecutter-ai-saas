import { ReactNode } from "react";
import Link from "next/link";
import { Main } from "@/components/ui/skip-link";

/**
 * The shell every legal page shares, the Privacy Policy and Terms included,
 * with a way back to the hub.
 *
 * A page with an `intro` explains how this app is built, and ends with the
 * not-legal-advice notice. A page with `lastUpdated` is one of the operator's
 * own policies: it is dated instead, and carries no such notice, which would
 * undercut it.
 */
export function LegalPage({
  title,
  back = { href: "/legal", label: "All legal pages" },
  intro,
  lastUpdated,
  children,
}: {
  title: string;
  back?: { href: string; label: string };
  children: ReactNode;
} & ({ intro: ReactNode; lastUpdated?: never } | { lastUpdated: Date; intro?: never })) {
  return (
    <Main className="min-h-screen bg-base-100">
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <Link href={back.href} className="mb-8 inline-flex items-center gap-2 text-sm text-base-content/60 hover:text-base-content">
          <span>&larr;</span>
          {back.label}
        </Link>

        <div className="space-y-3">
          <p className="text-sm font-medium text-primary">__PROJECT_NAME__ {lastUpdated ? title : "Legal"}</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{title}</h1>
          {lastUpdated ? (
            <p className="text-sm text-base-content/60">
              Last updated:{" "}
              {lastUpdated.toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          ) : (
            <p className="text-base-content/80">{intro}</p>
          )}
        </div>

        <div className="mt-10 space-y-8 text-base-content/80">{children}</div>

        {!lastUpdated && (
          <p className="mt-12 border-t border-base-content/10 pt-6 text-sm text-base-content/60">
            This page describes how this app is built. It is not legal advice, and
            following it does not by itself make an app compliant with any law.
          </p>
        )}
      </div>
    </Main>
  );
}

/** A titled section: "The risk" and "How this app handles it" on a topic page, a numbered clause on a policy. */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-base-content">{title}</h2>
      {children}
    </section>
  );
}
