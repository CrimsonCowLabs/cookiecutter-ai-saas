import type { Metadata } from "next";
import Link from "next/link";
import { Main } from "@/components/ui/skip-link";
import { readUnsubscribeToken } from "@/lib/unsubscribe";

interface UnsubscribePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const param = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

type State = "confirm" | "done" | "invalid";

async function stateOf({ searchParams }: UnsubscribePageProps): Promise<{ state: State; token?: string }> {
  const params = await searchParams;
  if (params.status === "done") return { state: "done" };
  const token = param(params.token);
  return token && readUnsubscribeToken(token) ? { state: "confirm", token } : { state: "invalid" };
}

export async function generateMetadata(props: UnsubscribePageProps): Promise<Metadata> {
  const { state } = await stateOf(props);
  return {
    title: state === "invalid" ? "Error: Unsubscribe" : "Unsubscribe",
    robots: { index: false, follow: false },
  };
}

/**
 * Where a marketing email's unsubscribe link lands (lib/marketing-email.ts).
 * One button, posting a plain form to /api/unsubscribe, so it works without
 * JavaScript and without signing in. Asking first, rather than unsubscribing
 * on load, keeps link scanners that open every link in an email from
 * unsubscribing anyone.
 *
 * Never says whether the address has an account: the same page shows for
 * any genuinely signed link.
 */
export default async function UnsubscribePage(props: UnsubscribePageProps) {
  const { state, token } = await stateOf(props);

  return (
    <Main className="min-h-screen bg-base-100 flex items-center justify-center p-8">
      <div className="card w-full max-w-md border border-base-200 bg-base-100 shadow-xs">
        <div className="card-body gap-6">
          {state === "confirm" && (
            <>
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold">Unsubscribe from marketing email</h1>
                <p className="text-base-content/70">
                  You will stop getting newsletters and offers from us at this address. Emails you need about your
                  account will still arrive.
                </p>
              </div>
              <form method="post" action="/api/unsubscribe">
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="btn btn-primary w-full">
                  Unsubscribe
                </button>
              </form>
            </>
          )}
          {state === "done" && (
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold">You are unsubscribed</h1>
              <p className="text-base-content/70">
                We will not send marketing email to this address again. Emails about your account will still
                arrive.
              </p>
            </div>
          )}
          {state === "invalid" && (
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold">This unsubscribe link is not valid</h1>
              <p role="alert" className="text-base-content/70">
                Error: the link may have been cut short. Open it again from the email, or use the unsubscribe button
                your mail app shows.
              </p>
            </div>
          )}
          <p className="text-sm text-base-content/70">
            <Link href="/legal/email-preferences" className="link">
              Which emails we send, and how to opt out
            </Link>
          </p>
        </div>
      </div>
    </Main>
  );
}
