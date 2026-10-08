import { NextRequest, NextResponse } from "next/server";
import { readUnsubscribeToken, suppress } from "@/lib/unsubscribe";

/**
 * The unsubscribe endpoint every marketing email's List-Unsubscribe header
 * names (lib/marketing-email.ts). The confirmation page a reader sees is
 * app/(main)/unsubscribe/page.tsx; a page and a route handler can't share a
 * path, so the page lives at /unsubscribe and this at /api/unsubscribe.
 *
 * - GET (a mail client that opens the header's URL in a browser) is sent on
 *   to the confirmation page, which asks before doing anything: link
 *   scanners follow GET links, so a GET must never unsubscribe.
 * - POST does unsubscribe. It answers both the confirmation page's form,
 *   with a redirect back to that page, and RFC 8058 one-click requests from
 *   mail clients (a body of "List-Unsubscribe=One-Click"), with a bare 200.
 *
 * Repeating a request changes nothing, and nothing here looks at `users`, so
 * the response is the same whether or not the address has an account.
 */

const token = (req: NextRequest, form?: FormData) => {
  const fromForm = form?.get("token");
  return typeof fromForm === "string" && fromForm ? fromForm : req.nextUrl.searchParams.get("token");
};

const redirect = (query: string) =>
  new NextResponse(null, { status: 303, headers: { Location: `/unsubscribe?${query}` } });

export async function GET(req: NextRequest) {
  const given = token(req);
  return redirect(given ? new URLSearchParams({ token: given }).toString() : "");
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => undefined);
  const oneClick = form?.get("List-Unsubscribe") === "One-Click";
  const email = readUnsubscribeToken(token(req, form));

  if (!email) {
    if (oneClick) return new NextResponse("This unsubscribe link is not valid.", { status: 400 });
    return redirect("status=invalid");
  }

  await suppress(email, oneClick ? "one-click" : "unsubscribe-page");
  if (oneClick) return new NextResponse("You have been unsubscribed.", { status: 200 });
  return redirect("status=done");
}
