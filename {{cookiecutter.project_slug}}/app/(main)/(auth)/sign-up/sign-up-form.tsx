"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
// cc:begin magic-link
import { MagicLinkForm } from "@/components/auth/magic-link-form";
// cc:end magic-link

export function SignUpForm() {
  const searchParams = useSearchParams();

  const planId = searchParams.get("plan_id") || undefined;
  const callbackUrl = searchParams.get("callbackUrl") || searchParams.get("redirect") || "/dashboard";

  return (
    <AuthForm
      title="Create your account"
      description="Get started with __PROJECT_NAME__ in minutes."
      showOAuth
      callbackUrl={callbackUrl}
      planId={planId}
      footer={
        <>
          Already have an account?{" "}
          <Link
            href={planId ? `/sign-in?plan_id=${planId}` : "/sign-in"}
            className="link link-primary"
          >
            Log in
          </Link>
        </>
      }
    >
      {/* cc:begin magic-link */}
      <MagicLinkForm planId={planId} callbackUrl={callbackUrl} />
      {/* cc:end magic-link */}

      <p className="text-center text-xs text-base-content/60">
        By signing up, you agree to our{" "}
        <Link href="/privacy-policy" className="link link-hover">
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link href="/tos" className="link link-hover">
          Terms of Service
        </Link>
        .
      </p>
    </AuthForm>
  );
}
