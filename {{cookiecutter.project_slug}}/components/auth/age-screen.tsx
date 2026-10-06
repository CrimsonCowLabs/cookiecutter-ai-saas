import Link from "next/link";
import config from "@/config";

interface AgeScreenProps {
  /** The last date submitted wasn't a usable date of birth. */
  invalid?: boolean;
  /** The visitor was sent here by a sign-in that would have created an account. */
  newAccount?: boolean;
  planId?: string;
  callbackUrl?: string;
}

const ERROR_ID = "date-of-birth-error";

/**
 * The neutral age screen /sign-up shows before any way to sign up (see
 * lib/age-check.ts). Neutral, as the FTC asks: it asks for a full date of
 * birth, starts empty, and never says what age is needed.
 *
 * A server component posting a plain form, so it works without JavaScript.
 * A page that comes back with an error says so in its title (see
 * app/(main)/(auth)/sign-up/page.tsx), and the error is a role="alert" the
 * date input points at with aria-describedby. It does not steal focus, so the
 * first Tab still reaches the skip link.
 */
export function AgeScreen({ invalid, newAccount, planId, callbackUrl }: AgeScreenProps) {
  return (
    <div className="card w-full max-w-md border border-base-200 bg-base-100 shadow-xs">
      <div className="card-body gap-6">
        <div className="space-y-2 text-left">
          <h1 className="text-2xl font-semibold">Create your account</h1>
          <p className="text-sm text-base-content/70">
            {newAccount
              ? "We couldn't find an account for that sign-in. To create one, first enter your date of birth."
              : "First, enter your date of birth."}
          </p>
        </div>

        <form method="post" action="/api/age-check" className="space-y-4">
          {planId && <input type="hidden" name="plan_id" value={planId} />}
          {callbackUrl && <input type="hidden" name="callbackUrl" value={callbackUrl} />}

          <div className="space-y-2">
            <label htmlFor="date-of-birth" className="block text-sm font-medium">
              Date of birth
            </label>
            {invalid && (
              <p id={ERROR_ID} role="alert" className="text-sm font-medium">
                Error: enter your full date of birth (day, month and year).
              </p>
            )}
            <input
              id="date-of-birth"
              name="dateOfBirth"
              type="date"
              required
              autoComplete="bday"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? ERROR_ID : undefined}
              className={`input w-full ${invalid ? "input-error" : ""}`}
            />
          </div>

          <button type="submit" className="btn btn-primary w-full">
            Continue
          </button>
        </form>

        {/* No link to /legal/children here: it says what age is needed. */}
        <p className="text-sm text-base-content/70">
          We use your date of birth only to check that you can create an account, and we
          don&apos;t keep it.
        </p>

        <div className="text-left text-sm text-base-content/70">
          Already have an account?{" "}
          <Link href={planId ? `/sign-in?plan_id=${planId}` : "/sign-in"} className="link link-primary">
            Log in
          </Link>
        </div>
      </div>
    </div>
  );
}

/** What a visitor the age screen turned away sees instead, until the refusal expires. */
export function TurnedAway() {
  return (
    <div className="card w-full max-w-md border border-base-200 bg-base-100 shadow-xs">
      <div className="card-body gap-4">
        <h1 className="text-2xl font-semibold">Sorry, we can&apos;t create an account for you</h1>
        <p className="text-sm text-base-content/70">
          You can still read everything on {config.appName} that doesn&apos;t need an account. We
          haven&apos;t kept your date of birth or anything else about you.
        </p>
        <p className="text-sm text-base-content/70">
          <Link href="/" className="link">
            Back to the home page
          </Link>
          {" · "}
          <Link href="/legal/children" className="link">
            Children&apos;s privacy
          </Link>
        </p>
      </div>
    </div>
  );
}
