# Public site design system

This is the token and component reference for `site/`'s two themes, **Dark**
and **Light**. `docs/public-site.md`'s "Look and themes"
section covers the *why* — the claude.ai design project this was translated
from, the DaisyUI-style approach, how the toggle and `localStorage` work.
This doc is the *what*: the concrete values, so you can change or extend the
page without re-deriving them from `site/styles.css`.

`site/styles.css` is the single source of truth. When this doc and the CSS
disagree, the CSS is right — fix the doc.

This is **not** the generated app's own theme system. `{{cookiecutter.project_slug}}/app/globals.css`
configures DaisyUI themes chosen at generation time (see
[Changing the theme](customization.md#changing-the-theme) in the
customization guide) and has no Dark or Light theme at all. The two systems
happen to share a DaisyUI-style shape — CSS custom properties for colour and
radius, plain classes like `.btn` and `.badge` — because the site's design was
translated from the generated app's own design system, but they are
independent: changing one does not change the other.

## Themes: Dark and Light

Both themes are set by `data-theme` on `<html>` (`"dark"` or `"light"`).
With no `data-theme`, `prefers-color-scheme` picks one in plain CSS, so the
page is correctly themed with its script disabled.

| Token                     | Dark (default)             | Light                       |
| ------------------------- | -------------------------- | --------------------------- |
| `color-scheme`            | `dark`                      | `light`                      |
| `--color-base-100`        | `#100d0c`                   | `#faf8f5`                    |
| `--color-base-200`        | `#1a1514`                   | `#f1ede6`                    |
| `--color-base-300`        | `#2f2523`                   | `#e4ddd2`                    |
| `--color-base-content`    | `#f6f1ee`                   | `#1c1917`                    |
| `--color-primary`         | `#f2703a`                   | `#b4370a`                    |
| `--color-primary-content` | `#1a0d07`                   | `#ffffff`                    |
| `--color-neutral`         | `#0a0807`                   | `#1c1917`                    |
| `--color-neutral-content` | `#f6f1ee`                   | `#faf8f5`                    |
| `--color-glow`            | `#f5a524`                   | `#0f766e`                    |
| `--color-glow-strong`     | `#fbbf4a`                   | `#0d9488`                    |
| `--color-warning`         | `#f5a524`                   | `#b45309`                    |
| `--color-warning-content` | `#1a0d07`                   | `#ffffff`                    |
| `--radius-selector`       | `0.375rem`                  | `0.125rem`                   |
| `--radius-field`          | `0.375rem`                  | `0.125rem`                   |
| `--radius-box`            | `0.5rem`                    | `0.25rem`                    |
| `--depth`                 | `1`                         | `0`                          |

`--depth` scales the subtle inset highlight and drop shadow on `.btn` — Dark
reads as slightly raised, Light deliberately flat. The navbar's theme toggle
swatches (`.swatch-dark` `#f2703a`, `.swatch-light` `#b4370a`) are hardcoded
hex literals, not `var(--color-primary)` — they currently match each theme's
primary colour, but if either theme's `--color-primary` ever moves, update
the matching swatch by hand or the two will silently drift apart.

Light's block appears twice in `styles.css` — once under
`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {…} }`,
once under `[data-theme="light"] {…}` — because a custom-property block can't
be shared between two selectors in different at-rules. Keep both identical
when editing either.

A third theme, "Slate", was explored in the source design project and
deliberately not shipped. There is no dormant CSS for it to resurrect.

## Derived tokens

Declared once on `:root` (not per-theme) and computed from whichever theme's
base tokens are active, all via `color-mix(in oklab, …)`:

| Token              | Formula                                               | Used for                          |
| ------------------- | ------------------------------------------------------ | ---------------------------------- |
| `--surface-card`    | `color-mix(in oklab, var(--color-base-200) 50%, transparent)` | Card and navbar backgrounds |
| `--surface-tint`    | `color-mix(in oklab, var(--color-base-200) 30%, transparent)` | Section background tint      |
| `--text-strong`     | `color-mix(in oklab, var(--color-base-content) 80%, transparent)` | Emphasis text            |
| `--text-muted`      | `color-mix(in oklab, var(--color-base-content) 60%, transparent)` | Secondary text            |
| `--text-faint`      | `color-mix(in oklab, var(--color-base-content) 40%, transparent)` | Least prominent text      |
| `--border-subtle`   | `color-mix(in oklab, var(--color-base-content) 5%, transparent)` | Hairline dividers          |
| `--border-strong`   | `color-mix(in oklab, var(--color-base-content) 10%, transparent)` | More visible borders     |
| `--border-field`    | `color-mix(in oklab, var(--color-base-content) 20%, transparent)` | Input/checkbox borders  |
| `--primary-soft`    | `color-mix(in oklab, var(--color-primary) 10%, transparent)` | Tag/step/prerelease fill       |
| `--primary-line`    | `color-mix(in oklab, var(--color-primary) 20%, transparent)` | Tag/step/prerelease border     |

None of these are set per-theme directly — they recompute automatically
whenever `--color-base-*`/`--color-primary` change, so a new theme only ever
needs the base token table above, never its own copy of these.

## Typography

```
--font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

The source design project specifies Inter (sans) and JetBrains Mono (mono)
from Google Fonts. `site/` deliberately uses system-font stacks instead — a
CDN font is an off-origin runtime dependency, which the page has none of (see
`docs/public-site.md`). If you are matching this design elsewhere and *can*
load webfonts, Inter/JetBrains Mono is the intended pairing; `site/` itself
should stay on system fonts.

Representative type scale (all `font:` shorthand, `weight size/line-height family`):

| Role                       | Spec                                            |
| -------------------------- | ------------------------------------------------ |
| Eyebrow / label            | `500 0.875rem/1.25rem var(--font-mono)`           |
| Hero title (`.hero-title`) | `800 clamp(2.25rem, 6vw, 3.75rem)/1.05 var(--font-mono)` |
| Section title              | `700 clamp(1.875rem, 4vw, 2.25rem)` (sans, default weight stack) |
| Section lede / tagline     | `1.125rem/1.625`, `var(--text-muted)`             |
| Body default               | `1rem/1.5 var(--font-sans)`                       |

Headline-weight text (`.eyebrow`, `.hero-title`, stack/choice `dt`, step
numbers) consistently uses `--font-mono`, not `--font-sans` — that's the
"technical product" voice running through the whole page, not an accident of
one component.

## Spacing and shape

There is no fixed breakpoint spacing scale — nearly every section/block
spacing value is `clamp(min, preferred-vw, max)`, so the page has one layout
to reason about between a phone and a wide desktop rather than a layout per
breakpoint. `--border: 1px` is the one hairline width used everywhere;
corner radius comes entirely from the three `--radius-*` tokens above, which
is why Dark reads rounder and Light reads sharper without any component CSS
knowing which theme is active.

Motion: `--ease-out: cubic-bezier(0, 0, 0.2, 1)` and
`--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1)` are the only two easing curves
used across hover/focus/active transitions. `@media (prefers-reduced-motion: reduce)`
collapses every transition to near-zero duration globally — don't special-case
an individual component's motion for this; the blanket rule already covers it.

## Components

Plain classes, DaisyUI-named, each theme-aware purely through the tokens
above — no component rule hardcodes a colour.

| Class                                   | Purpose                                              |
| ----------------------------------------- | ------------------------------------------------------ |
| `.btn`, `.btn-primary`, `.btn-ghost`       | Buttons. Base is `--color-base-200`; `-primary` swaps in `--color-primary`; `-ghost` is transparent until hover. |
| `.btn-sm`, `.btn-xs`                       | Size variants. `.btn`/`.btn-sm` floor at the 44px touch target; `.btn-xs` (24px) is the one deliberate exception, for the install card's packed copy button. |
| `.badge`, `.badge-primary`, `.badge-warning`, `.badge-sm` | Inline status pills (e.g. the pre-release status line). |
| `.tag`                                     | Small outlined label using `--primary-soft`/`--primary-line`. |
| `.checkbox`                                | Custom checkbox (checklist items); checked state fills with `--color-primary`. |
| `.textarea`                                | Monospace textarea (checklist's "copy as Markdown" fallback). |
| `.navbar`, `.navbar-inner`, `.brand`, `.nav-links` | Sticky, blurred-backdrop header and its contents. |
| `.theme-toggle`, `.theme-option`, `.swatch-dark`, `.swatch-light` | The Dark/Light switch inserted into the navbar by the inline script; hidden (`:empty`) if the script never runs. |
| `.surface-card`                            | The generic elevated card (problem cards, progress panel, phases). |
| `.stack-list`, `.choice-list`              | The two definition-list layouts (stack table, generation-time choices grid). |
| `.steps`                                   | Numbered quickstart list; `.is-done` swaps the number for a checkmark. |
| `.progress`, `.progress-fill`              | Checklist progress bar; width is set by the script from done/total. |
| `.phase`                                   | One checklist phase (grouped checkbox list with its own heading/count). |
| `.prerelease`                              | The pre-release callout box. |
| `.ambient`                                 | The two fixed, blurred background glows — `pointer-events: none`, purely decorative. |

This list favours "what is this for" over restating every rule; for exact
property values, read the class in `site/styles.css` — each is grouped under
a `/* ---------- Section ---------- */` comment matching the heading above.

## Theme switching mechanics

Covered in full in `docs/public-site.md`; summary for this reference's
purpose: the toggle script lives in `<head>` (so a remembered theme applies
before first paint), sets `data-theme` on `<html>`, and persists the choice to
`localStorage` under `cookiecutter-ai-saas-theme` only when it overrides what
`prefers-color-scheme` would already pick — picking the system's own answer
clears the override instead of recording it redundantly.
