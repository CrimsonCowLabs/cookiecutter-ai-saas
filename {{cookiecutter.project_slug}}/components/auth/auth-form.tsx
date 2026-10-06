"use client";

import { OAuthButtons } from "./oauth-buttons";

interface AuthFormProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  showOAuth?: boolean;
  callbackUrl?: string;
  planId?: string;
  footer?: React.ReactNode;
}

export function AuthForm({
  title,
  description,
  children,
  showOAuth = true,
  callbackUrl,
  planId,
  footer,
}: AuthFormProps) {
  return (
    <div className="card w-full max-w-md border border-base-200 bg-base-100 shadow-xs">
      <div className="card-body gap-6">
        <div className="space-y-2 text-left">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description && (
            <p className="text-sm text-base-content/60">
              {description}
            </p>
          )}
        </div>
        {showOAuth && (
          <div>
            <OAuthButtons callbackUrl={callbackUrl} planId={planId} />
            {/* cc:begin magic-link */}
            <div className="divider text-xs uppercase tracking-[0.2em] text-base-content/70">or</div>
            {/* cc:end magic-link */}
          </div>
        )}

        {children}

        {footer && (
          <div className="text-left text-sm text-base-content/60">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
