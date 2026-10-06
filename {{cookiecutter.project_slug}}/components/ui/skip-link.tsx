import { ReactNode } from "react";

const MAIN_CONTENT_ID = "main-content";

/**
 * "Skip to content": the first Tab stop on every page, so a keyboard user can
 * jump past the navigation instead of tabbing through it on every page
 * (WCAG 2.4.1). Off-screen until it has focus; see .skip-link in globals.css.
 * Rendered once, by app/(main)/layout.tsx.
 */
export function SkipLink() {
  return (
    <a href={`#${MAIN_CONTENT_ID}`} className="skip-link btn btn-primary">
      Skip to content
    </a>
  );
}

/**
 * A page's main content, and where SkipLink jumps to. Every page renders
 * exactly one, around everything but its navigation and footer.
 * tabIndex={-1} lets following the skip link move focus here, not just
 * scroll, so the next Tab continues from the content.
 */
export function Main({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={className}>
      {children}
    </main>
  );
}
