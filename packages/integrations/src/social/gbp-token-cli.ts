/**
 * Mints the Google Business Profile refresh token, in one command.
 *
 *   pnpm gbp:token -- --client-id=<id> --client-secret=<secret>
 *
 * Why this exists. `GBP_CLIENT_ID` and `GBP_CLIENT_SECRET` you can copy out of
 * the Google Cloud console. `GBP_REFRESH_TOKEN` you cannot: it is only issued
 * after a human signs into a Google account in a browser and consents, so
 * there is no API, no service-account shortcut, and nobody can produce it on
 * your behalf. That last step is where people give up, and the usual
 * instructions are a tutorial with a dozen screenshots and a deprecated
 * `urn:ietf:wg:oauth:2.0:oob` redirect that Google has since switched off.
 *
 * So this does the fiddly parts: builds the consent URL with the right scope
 * and the two parameters everybody forgets, listens on a loopback port for the
 * redirect, exchanges the code, and prints the token.
 *
 * **The two parameters everybody forgets** are `access_type=offline` and
 * `prompt=consent`. Without the first, Google issues an access token that
 * expires in an hour and no refresh token at all. Without the second, a
 * Google account that has already consented once is sent straight back
 * *without* a refresh token — which is the failure that makes people think
 * they did something wrong the second time when the first attempt was the
 * problem. Together they guarantee a refresh token every run.
 *
 * **Loopback, not out-of-band.** A Desktop-app OAuth client may redirect to
 * `http://localhost:<port>`, and Google removed the copy-the-code-from-a-page
 * flow. So the script holds a one-request server open, and the browser hands
 * the code back by itself.
 *
 * Nothing is written anywhere. The token is printed once, for you to paste
 * into Coolify on the web and worker apps — a credential this script saved to
 * a file would be a credential sitting on a laptop.
 */
import { createServer } from "node:http";
import { GBP_OAUTH_SCOPE } from "./gbp.js";
import { GOOGLE_OAUTH_TOKEN_URL } from "./gbp-oauth.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Any free high port; it only has to match the redirect Google is told about. */
const DEFAULT_PORT = 5710;

/** Long enough to find the right Google account and read a consent screen. */
const WAIT_MS = 5 * 60_000;

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((v) => v === `--${name}` || v.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).trim();
}

/** The page the browser lands on, so the tab does not sit on a blank screen. */
function donePage(ok: boolean): string {
  const heading = ok ? "Done — go back to the terminal" : "Something went wrong";
  const body = ok
    ? "Your refresh token has been printed there. You can close this tab."
    : "Nothing was issued. The terminal has the reason.";
  return `<!doctype html><meta charset="utf-8"><title>${heading}</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f7fa;
             font:16px/1.6 system-ui,sans-serif;color:#141b29">
  <div style="max-width:28rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.375rem;font-weight:540;letter-spacing:-.03em;margin:0 0 .5rem">${heading}</h1>
    <p style="margin:0;color:#4d5c70">${body}</p>
  </div>
</body>`;
}

/** Holds a server open for the single redirect Google will make, then closes. */
async function waitForCode(port: number): Promise<{ code?: string; error?: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://localhost:${port}`);
      // Browsers ask for /favicon.ico; answering it stops a stray request
      // being mistaken for the redirect.
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      const code = url.searchParams.get("code") ?? undefined;
      const error = url.searchParams.get("error") ?? undefined;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(donePage(Boolean(code)));
      server.close();
      resolve({ ...(code ? { code } : {}), ...(error ? { error } : {}) });
    });
    server.listen(port, "127.0.0.1");
    const timer = setTimeout(() => {
      server.close();
      resolve({ error: "timed out waiting for the browser" });
    }, WAIT_MS);
    server.on("close", () => clearTimeout(timer));
  });
}

async function main(): Promise<void> {
  const clientId = arg("client-id") ?? process.env.GBP_CLIENT_ID?.trim();
  const clientSecret = arg("client-secret") ?? process.env.GBP_CLIENT_SECRET?.trim();
  const port = Number(arg("port") ?? DEFAULT_PORT);

  if (!clientId || !clientSecret) {
    console.error(
      [
        "Need the OAuth client from Google Cloud:",
        "",
        "  pnpm gbp:token -- --client-id=<id> --client-secret=<secret>",
        "",
        "Get them from console.cloud.google.com → APIs & Services → Credentials →",
        "Create credentials → OAuth client ID → Desktop app. The Google Business",
        "Profile API has to be enabled on the same project first.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const redirectUri = `http://localhost:${port}`;
  const consent = new URL(AUTH_URL);
  consent.searchParams.set("client_id", clientId);
  consent.searchParams.set("redirect_uri", redirectUri);
  consent.searchParams.set("response_type", "code");
  consent.searchParams.set("scope", GBP_OAUTH_SCOPE);
  // The two that decide whether a refresh token exists at all.
  consent.searchParams.set("access_type", "offline");
  consent.searchParams.set("prompt", "consent");

  console.log("\nOpen this in a browser, signed in as the Google account that manages your clients' listings:\n");
  console.log(`  ${consent.toString()}\n`);
  console.log(`Waiting on ${redirectUri} — approve the consent screen and this will finish by itself.\n`);

  const { code, error } = await waitForCode(port);
  if (error || !code) {
    console.error(`Nothing issued: ${error ?? "no code came back"}`);
    process.exitCode = 1;
    return;
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const payload = (await response.json()) as { refresh_token?: string; error_description?: string; error?: string };

  if (!response.ok || !payload.refresh_token) {
    console.error(`Google refused the exchange: ${payload.error_description ?? payload.error ?? response.status}`);
    if (response.ok && !payload.refresh_token) {
      // The one failure worth explaining, because the cause is invisible.
      console.error("It returned an access token but no refresh token — that happens when the account has consented");
      console.error("before. Revoke this app at myaccount.google.com/permissions and run it again.");
    }
    process.exitCode = 1;
    return;
  }

  console.log("Paste these three into Coolify on BOTH launchos-web and launchos-worker, then restart both:\n");
  console.log(`  GBP_CLIENT_ID=${clientId}`);
  console.log(`  GBP_CLIENT_SECRET=${clientSecret}`);
  console.log(`  GBP_REFRESH_TOKEN=${payload.refresh_token}\n`);
  console.log("Nothing has been saved to disk. This is the only time the refresh token is shown.\n");
}

await main();
// The loopback server is closed, but an open keep-alive socket can still hold
// the loop; nothing is pending, so exit on the code main set.
process.exit(process.exitCode ?? 0);
