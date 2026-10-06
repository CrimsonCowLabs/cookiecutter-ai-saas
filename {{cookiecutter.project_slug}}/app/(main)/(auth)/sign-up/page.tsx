import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SignUpForm } from "./sign-up-form";
import { Suspense } from "react";
import { Main } from "@/components/ui/skip-link";
import { AgeScreen, TurnedAway } from "@/components/auth/age-screen";
import { readAgeCheck } from "@/lib/age-check";

interface SignUpPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const param = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

export async function generateMetadata({ searchParams }: SignUpPageProps): Promise<Metadata> {
  // A page that comes back with an error says so in its title too, the first
  // thing a screen reader reads out.
  return { title: param((await searchParams).age_error) ? "Error: Sign Up" : "Sign Up" };
}

/**
 * Sign-up is two steps: the age screen (components/auth/age-screen.tsx), then
 * the sign-in buttons and magic-link form. Which one shows is decided here,
 * from the signed age-check cookie, so the buttons are never on the page until
 * the screen is passed. lib/auth.ts enforces the same rule for any sign-in
 * that would create an account, wherever it starts.
 */
export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = await searchParams;
  const ageCheck = readAgeCheck(await cookies());
  const planId = param(params.plan_id);
  const callbackUrl = param(params.callbackUrl);

  return (
    <Main className="min-h-screen bg-base-100 flex">
      {/* Left — Form */}
      <div className="flex-1 flex items-center justify-center p-8">
        {ageCheck.status === "passed" ? (
          <Suspense fallback={<div className="loading loading-spinner loading-lg" />}>
            <SignUpForm />
          </Suspense>
        ) : ageCheck.status === "turned-away" ? (
          <TurnedAway />
        ) : (
          <AgeScreen
            invalid={params.age_error === "invalid"}
            newAccount={params.age_check === "required"}
            planId={planId}
            callbackUrl={callbackUrl}
          />
        )}
      </div>

      {/* Right — Decorative */}
      <div className="hidden lg:flex flex-1 relative overflow-hidden bg-base-200">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>
    </Main>
  );
}
