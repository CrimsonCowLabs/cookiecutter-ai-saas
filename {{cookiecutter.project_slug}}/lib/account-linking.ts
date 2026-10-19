/**
 * Whether a sign-in may be linked, by its email alone, to an existing account
 * with that address.
 *
 * lib/auth.config.ts lets Auth.js link that way (allowDangerousEmailAccountLinking),
 * which is only as safe as the provider's word that the email is the
 * person's. Google verifies its emails, and a magic link proves the inbox
 * itself. Microsoft Entra ID does not: its `email` claim is whatever a
 * tenant's admin typed in, so anyone can make a tenant, give a user someone
 * else's address and sign in as them (the "nOAuth" attack). A Microsoft
 * sign-in is linked by email only when the ID token says the email can be
 * trusted:
 *
 * - Microsoft verified the email's domain: the `xms_edov` claim is true.
 *   It is an optional claim; add it to the app registration's ID token
 *   (Token configuration) for it to be sent.
 * - Or the app is configured for one tenant (MICROSOFT_ENTRA_ID_TENANT_ID,
 *   its Directory (tenant) ID GUID) and the sign-in is by a member of it
 *   (`tid`): that directory is yours, and so are the emails in it. Not a
 *   guest: a guest also signs in with your `tid`, but their email comes
 *   from their home tenant, so it proves nothing.
 *
 * lib/auth.ts asks this in the signIn callback, before Auth.js links
 * anything, and only for a sign-in that is not already linked to an account.
 * A returning user, and a first sign-in with an email no account has, are
 * never asked.
 *
 * Pure: everything it needs is passed in.
 */

export const MICROSOFT_PROVIDER_ID = "microsoft-entra-id";

// Not tenants: Entra's multi-tenant endpoints, which take anyone's.
const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

/**
 * @param provider The Auth.js provider id the sign-in came through.
 * @param profile The provider's claims about the person: for Microsoft, the
 *   validated ID token's (the signIn callback's `profile`).
 * @param tenantId The configured MICROSOFT_ENTRA_ID_TENANT_ID, if any.
 */
export function mayLinkByEmail(
  provider: string,
  profile: Record<string, unknown> | undefined,
  tenantId: string | undefined
): boolean {
  if (provider !== MICROSOFT_PROVIDER_ID) return true;

  // Documented as a boolean; nothing else counts.
  if (profile?.xms_edov === true) return true;

  const tenant = tenantId?.trim().toLowerCase();
  if (!tenant || MULTI_TENANT.has(tenant)) return false;
  if (typeof profile?.tid !== "string" || profile.tid.toLowerCase() !== tenant) return false;
  return !isGuest(profile, tenant);
}

/**
 * Whether the person signed in to `tenant` as a guest homed elsewhere.
 *
 * Microsoft's ID token reference
 * (https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
 * says `idp`, the identity provider that authenticated the user, "is
 * identical to the value of the issuer claim unless the user account isn't
 * in the same tenant as the issuer - guests, for instance", and that when
 * it is absent `iss` applies. So a member has no `idp`, or one naming this
 * tenant; a guest's names their home tenant (or live.com, for a personal
 * account). The optional `acct` claim (1 for a guest) is not used: it is
 * only sent once added to the app registration, so its absence proves
 * nothing.
 */
function isGuest(profile: Record<string, unknown>, tenant: string): boolean {
  const idp = profile.idp;
  if (idp === undefined) return false;
  return typeof idp !== "string" || !idp.toLowerCase().includes(tenant);
}
