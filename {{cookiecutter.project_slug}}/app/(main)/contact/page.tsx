import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ContactForm } from "./contact-form";
import { Main } from "@/components/ui/skip-link";

export default function ContactPage() {
  return (
    <Main className="min-h-screen bg-base-100">
      <div className="mx-auto max-w-4xl px-6 py-16">
        <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm text-base-content/60 hover:text-base-content">
          <span>&larr;</span>
          Back to home
        </Link>

        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-6 sm:p-8">
          <div className="mb-6 flex items-start gap-4">
            <Logo className="h-10 w-10 text-primary" />
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Get in Touch</h1>
              <p className="mt-2 max-w-2xl text-sm text-base-content/70">
                Have a question, suggestion, or need help? We&apos;d love to hear from you.
                Fill out the form below and we&apos;ll get back to you as soon as possible.
              </p>
            </div>
          </div>

          <ContactForm />
        </div>
      </div>
    </Main>
  );
}
