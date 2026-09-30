"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { buildAuthRedirectUrl } from "@/lib/pending-plan";

interface MagicLinkFormProps {
  planId?: string;
  callbackUrl?: string;
  onSuccess?: () => void;
}

export function MagicLinkForm({ planId, callbackUrl, onSuccess }: MagicLinkFormProps) {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const nextCallbackUrl = buildAuthRedirectUrl(callbackUrl, planId);

      const result = await signIn("resend", {
        email,
        redirect: false,
        callbackUrl: nextCallbackUrl,
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      setSuccess(true);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="alert alert-success">
        <span>
          Check your email! We&apos;ve sent a magic link to <strong>{email}</strong>.
          Click the link in the email to sign in.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="alert alert-error">
          <span>{error}</span>
        </div>
      )}

      <label className="input flex items-center gap-2">
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={isLoading}
          className="grow"
        />
      </label>

      <button type="submit" className="btn btn-primary w-full" disabled={isLoading}>
        {isLoading && <span className="loading loading-spinner" />}
        Send magic link
      </button>
    </form>
  );
}
