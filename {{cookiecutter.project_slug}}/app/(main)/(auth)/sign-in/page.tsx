import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";
import { Suspense } from "react";
import { Main } from "@/components/ui/skip-link";

export const metadata: Metadata = {
  title: "Sign In",
};

export default function SignInPage() {
  return (
    <Main className="min-h-screen bg-base-100 flex">
      {/* Left — Form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <Suspense fallback={<div className="loading loading-spinner loading-lg" />}>
          <SignInForm />
        </Suspense>
      </div>

      {/* Right — Decorative */}
      <div className="hidden lg:flex flex-1 relative overflow-hidden bg-base-200">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>
    </Main>
  );
}
