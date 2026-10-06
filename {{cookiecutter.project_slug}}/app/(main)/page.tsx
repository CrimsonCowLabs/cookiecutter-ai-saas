import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { Logo } from "@/components/brand/logo";
import { Navbar } from "@/components/ui/navbar";
import { Footer } from "@/components/ui/footer";
import { Main } from "@/components/ui/skip-link";

export const metadata: Metadata = {
  title: "__PROJECT_NAME__ | AI-Powered SaaS Platform",
  description: "__PROJECT_DESCRIPTION__",
  keywords: [
    "AI SaaS",
    "artificial intelligence",
    "machine learning",
    "automation",
    "AI platform",
  ],
  alternates: {
    canonical: "https://__DOMAIN_NAME__/",
  },
};

/* ─────────────── Inline SVG Icons ─────────────── */

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}

function ZapIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

function BarChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="20" y2="10" />
      <line x1="18" x2="18" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="16" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/* ─────────────── Features Data ─────────────── */

const features = [
  {
    icon: <SparklesIcon className="w-6 h-6" />,
    title: "AI-Powered Processing",
    description: "Submit jobs and let our AI models process your data automatically. Get intelligent results in minutes, not hours.",
  },
  {
    icon: <ZapIcon className="w-6 h-6" />,
    title: "Real-Time Status Updates",
    description: "Monitor job progress with live updates via Server-Sent Events. Know exactly what's happening at every step.",
  },
  {
    icon: <BrainIcon className="w-6 h-6" />,
    title: "Smart Analytics",
    description: "Get actionable insights from your data with AI-generated reports, trend analysis, and recommendations.",
  },
  {
    icon: <BarChartIcon className="w-6 h-6" />,
    title: "Dashboard & Reporting",
    description: "A clean, real-time dashboard shows your jobs, results, and usage metrics at a glance.",
  },
];

/* ─────────────── Pricing Data ─────────────── */

const plans = [
  {
    name: "Free",
    price: 0,
    interval: "forever",
    description: "Get started with basic features",
    features: [
      { name: "5 jobs per month", included: true },
      { name: "Basic AI processing", included: true },
      { name: "Email support", included: true },
      { name: "API access", included: false },
      { name: "Priority processing", included: false },
      { name: "Custom models", included: false },
    ],
    cta: "Get Started Free",
    href: "/sign-up",
    featured: false,
  },
  {
    name: "Pro",
    price: 29,
    interval: "month",
    description: "For professionals and growing teams",
    features: [
      { name: "100 jobs per month", included: true },
      { name: "Advanced AI processing", included: true },
      { name: "Priority support", included: true },
      { name: "API access", included: true },
      { name: "Priority processing", included: true },
      { name: "Custom models", included: false },
    ],
    cta: "Start Pro Trial",
    href: "/sign-up?plan_id=pro",
    featured: true,
  },
  {
    name: "Enterprise",
    price: 99,
    interval: "month",
    description: "For teams that need everything",
    features: [
      { name: "Unlimited jobs", included: true },
      { name: "Advanced AI processing", included: true },
      { name: "Dedicated support", included: true },
      { name: "API access", included: true },
      { name: "Priority processing", included: true },
      { name: "Custom models", included: true },
    ],
    cta: "Contact Sales",
    // cc:begin contact
    href: "/contact",
    // cc:end contact
    // cc:begin no-contact
    href: "/sign-up",
    // cc:end no-contact
    featured: false,
  },
];

/* ─────────────── Page ─────────────── */

export default async function LandingPage() {
  const session = await auth();
  const isAuthenticated = !!session?.user;

  return (
    <div className="min-h-screen bg-base-100 relative overflow-hidden">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-48 -left-48 w-[600px] h-[600px] rounded-full bg-primary/[0.04] blur-3xl" />
        <div className="absolute -bottom-48 -right-48 w-[500px] h-[500px] rounded-full bg-emerald-500/[0.03] blur-3xl" />
      </div>

      {/* Header */}
      <Navbar isAuthenticated={isAuthenticated} />

      <Main>

      {/* ─── HERO ─── */}
      <section className="relative z-10 max-w-6xl mx-auto px-6 pt-24 pb-20 lg:pt-32 lg:pb-28">
        <div className="max-w-3xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full bg-primary/10 text-primary border border-primary/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            AI-powered automation for modern teams
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1]">
            Automate Your Workflow.
            <br />
            <span className="text-transparent bg-clip-text bg-linear-to-r from-primary to-emerald-400">
              Powered by AI.
            </span>
          </h1>

          <p className="text-lg text-base-content/60 max-w-xl mx-auto leading-relaxed">
            __PROJECT_NAME__ helps you process, analyze, and act on your data with AI.
            Submit jobs, get real-time updates, and receive intelligent results — no
            expertise required.
          </p>

          <div className="flex flex-wrap justify-center gap-4">
            <Link href={isAuthenticated ? "/dashboard" : "/sign-up"} className="btn btn-primary gap-2">
              Get Started Free
              <ArrowRight className="w-4 h-4" />
            </Link>
            <a href="#features" className="btn btn-ghost gap-2 border border-base-content/10">
              See Features
              <ChevronDown className="w-4 h-4" />
            </a>
          </div>

          <div className="flex flex-wrap justify-center items-center gap-6 text-xs text-base-content/70 pt-2">
            <span className="flex items-center gap-1.5">
              <CheckIcon className="w-3.5 h-3.5 text-emerald-500" />
              Free to start
            </span>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="w-3.5 h-3.5 text-emerald-500" />
              No credit card required
            </span>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="w-3.5 h-3.5 text-emerald-500" />
              Results in minutes
            </span>
          </div>
        </div>
      </section>

      {/* ─── FEATURES ─── */}
      <section id="features" className="relative z-10 border-t border-base-content/5">
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="text-center mb-16">
            <p className="text-sm font-medium text-primary mb-3 font-[family-name:var(--font-mono)]">
              {"// features"}
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Everything you need to get started
            </h2>
            <p className="text-base-content/70 mt-4 max-w-lg mx-auto">
              A complete AI platform with real-time processing, smart analytics, and a beautiful dashboard.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {features.map((feature, i) => (
              <div
                key={i}
                className="relative group bg-base-200/50 border border-base-content/5 rounded-xl p-8 hover:border-primary/20 transition-colors"
              >
                <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-5">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-base-content/70 leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── PRICING ─── */}
      <section id="pricing" className="relative z-10 border-t border-base-content/5 bg-base-200/30">
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="text-center mb-16">
            <p className="text-sm font-medium text-primary mb-3 font-[family-name:var(--font-mono)]">
              {"// pricing"}
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Simple, transparent pricing
            </h2>
            <p className="text-base-content/70 mt-4 max-w-lg mx-auto">
              Start free, upgrade when you need more. No hidden fees.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`relative bg-base-200/50 border rounded-xl p-8 flex flex-col ${
                  plan.featured
                    ? "border-primary/40 ring-2 ring-primary/20"
                    : "border-base-content/5"
                }`}
              >
                {plan.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-medium px-3 py-1 rounded-full bg-primary text-primary-content">
                    Most Popular
                  </span>
                )}

                <div className="mb-6">
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="text-sm text-base-content/70 mt-1">{plan.description}</p>
                  <div className="mt-4">
                    <span className="text-4xl font-bold">
                      {plan.price === 0 ? "Free" : `$${plan.price}`}
                    </span>
                    {plan.price > 0 && (
                      <span className="text-sm text-base-content/70">/{plan.interval}</span>
                    )}
                  </div>
                </div>

                <ul className="space-y-3 flex-1 mb-8">
                  {plan.features.map((feature) => (
                    <li
                      key={feature.name}
                      className={`text-sm flex items-center gap-2 ${
                        feature.included ? "" : "text-base-content/70"
                      }`}
                    >
                      {feature.included ? (
                        <CheckIcon className="w-4 h-4 text-emerald-500 shrink-0" />
                      ) : (
                        <span className="w-4 h-4 flex items-center justify-center shrink-0" aria-hidden="true">—</span>
                      )}
                      <span className="sr-only">{feature.included ? "Included:" : "Not included:"}</span>
                      {feature.name}
                    </li>
                  ))}
                </ul>

                <Link
                  href={plan.href}
                  className={`btn w-full ${
                    plan.featured ? "btn-primary" : "btn-outline"
                  }`}
                >
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="relative z-10 border-t border-base-content/5">
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="bg-base-200/50 border border-base-content/5 rounded-2xl p-12 text-center">
            <ShieldIcon className="w-12 h-12 text-primary mx-auto mb-6" />
            <h2 className="text-3xl font-bold tracking-tight mb-4">
              Ready to get started?
            </h2>
            <p className="text-base-content/60 max-w-md mx-auto mb-8">
              Join thousands of teams using __PROJECT_NAME__ to automate their workflow
              with AI. Free to start, no credit card required.
            </p>
            <Link href={isAuthenticated ? "/dashboard" : "/sign-up"} className="btn btn-primary btn-lg gap-2">
              Start Free Today
              <ArrowRight className="w-5 h-5" />
            </Link>
          </div>
        </div>
      </section>

      </Main>

      {/* Footer */}
      <Footer />
    </div>
  );
}
