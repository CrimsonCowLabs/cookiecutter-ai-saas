import { NextRequest, NextResponse } from "next/server";
import {
  AGE_CHECK_PASSED_COOKIE,
  isOldEnough,
  parseDateOfBirth,
  passedCookie,
  readAgeCheck,
  turnedAwayCookie,
} from "@/lib/age-check";

/**
 * Where the age screen on /sign-up posts its date of birth. A plain form post
 * answered with a redirect back to /sign-up, so it works without JavaScript.
 *
 * The date of birth is read, compared and dropped here: only "passed" or
 * "turned away" leaves this handler, as a signed cookie (see lib/age-check.ts).
 * Never log the form body or put the date in the redirect.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();

  // Send the visitor back to the sign-up page they came from, keeping the
  // plan and destination they picked.
  const back = new URLSearchParams();
  for (const key of ["plan_id", "callbackUrl"]) {
    const value = form.get(key);
    if (typeof value === "string" && value) back.set(key, value);
  }
  const redirect = () =>
    new NextResponse(null, {
      status: 303,
      headers: { Location: `/sign-up${back.size ? `?${back}` : ""}` },
    });

  const now = new Date();
  // A visitor who was turned away stays turned away until the cookie
  // expires, whatever date they try next.
  if (readAgeCheck(req.cookies, now.getTime()).status === "turned-away") {
    return redirect();
  }

  const dateOfBirth = parseDateOfBirth(form.get("dateOfBirth"), now);
  if (!dateOfBirth) {
    back.set("age_error", "invalid");
    return redirect();
  }

  const res = redirect();
  if (isOldEnough(dateOfBirth, now)) {
    res.cookies.set(passedCookie(now.getTime()));
  } else {
    res.cookies.set(turnedAwayCookie(now.getTime()));
    res.cookies.delete(AGE_CHECK_PASSED_COOKIE);
  }
  return res;
}
