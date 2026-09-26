"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
// cc:begin magic-link
import { MagicLinkForm } from "@/components/auth/magic-link-form";
// cc:end magic-link

export function SignInForm() {
  const searchParams = useSearchParams();

  const planId = searchParams.get("plan_id") || undefined;
  const callbackUrl = searchParams.get("callbackUrl") || searchParams.get("redirect") || "/dashboard";

  return (
    <AuthForm
      title="Welcome back"
      description="Sign in to your __PROJECT_NAME__ account."
      showOAuth
      callbackUrl={callbackUrl}
      planId={planId}
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href={planId ? `/sign-up?plan_id=${planId}` : "/sign-up"}
            className="link link-primary"
          >
            Sign up
          </Link>
        </>
      }
    >
      {/* cc:begin magic-link */}
      <MagicLinkForm planId={planId} callbackUrl={callbackUrl} />
      {/* cc:end magic-link */}
    </AuthForm>
  );
}
