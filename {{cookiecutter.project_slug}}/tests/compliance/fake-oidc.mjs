// A stand-in for Google's and Microsoft's sign-in servers, so the age-gate
// tests can take a real OAuth sign-in all the way through the running app's
// Auth.js callback — the one place a new account is created — without a real
// Google or Microsoft account.
//
// scripts/check_compliance.sh boots the app with AUTH_GOOGLE_ISSUER and
// AUTH_MICROSOFT_ENTRA_ID_ISSUER pointing at http://localhost:<port>/<provider>
// (see lib/auth.config.ts), so the app discovers this server the same way it
// discovers the real ones. Only the browser half of the dance is skipped: a
// test reads the authorization URL the app redirects to, picks who "signed
// in" with issue(), and calls the app's callback with the code itself.
//
// Zero dependencies: node:http and node:crypto only.
import crypto from "node:crypto";
import http from "node:http";

export const FAKE_OIDC_PORT = Number(process.env.FAKE_OIDC_PORT || 3999);

const b64url = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * Start the fake provider. Returns { issue, close }:
 *
 *   issue(authorizationUrl, { sub, email, name }) — the query string the
 *     provider would send the browser back to the app's callback with: a
 *     code the app will exchange for an ID token saying `email` signed in
 *     (bound to that authorization request's client_id and nonce), its state,
 *     and the issuer (RFC 9207).
 */
export async function startFakeOidc() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fake", alg: "RS256", use: "sig" };
  const codes = new Map();

  const sign = (claims) => {
    const input = `${b64url({ alg: "RS256", kid: "fake", typ: "JWT" })}.${b64url(claims)}`;
    return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${FAKE_OIDC_PORT}`);
    const [, tenant, endpoint] = url.pathname.split("/");
    const issuer = `http://localhost:${FAKE_OIDC_PORT}/${tenant}`;
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (endpoint === ".well-known") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (endpoint === "jwks") return json(200, { keys: [jwk] });
    if (endpoint === "token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const grant = codes.get(new URLSearchParams(body).get("code"));
      if (!grant) return json(400, { error: "invalid_grant" });
      codes.delete(new URLSearchParams(body).get("code"));
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: crypto.randomBytes(16).toString("hex"),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
        id_token: sign({
          iss: issuer,
          aud: grant.clientId,
          sub: grant.sub,
          email: grant.email,
          email_verified: true,
          name: grant.name,
          iat: now,
          exp: now + 3600,
          ...(grant.nonce ? { nonce: grant.nonce } : {}),
        }),
      });
    }
    json(404, { error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(FAKE_OIDC_PORT, resolve);
  });

  return {
    issue(authorizationUrl, { sub, email, name = "Age Gate Test User" }) {
      const url = new URL(authorizationUrl);
      const params = url.searchParams;
      const code = crypto.randomBytes(16).toString("hex");
      codes.set(code, {
        clientId: params.get("client_id"),
        nonce: params.get("nonce"),
        sub,
        email,
        name,
      });
      return new URLSearchParams({
        code,
        state: params.get("state") ?? "",
        iss: `${url.origin}/${url.pathname.split("/")[1]}`,
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
