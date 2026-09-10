#!/usr/bin/env node
/**
 * Mints a Google Ads refresh token, once, on this machine.
 *
 * Run it after creating a new OAuth client in Google Cloud Console. It opens
 * the consent screen, catches the redirect on localhost, exchanges the code and
 * prints the three lines to paste into Coolify.
 *
 *   node scripts/google-ads-refresh-token.mjs <client-id> <client-secret>
 *
 * Why this exists: the refresh token is the one Google Ads credential that
 * cannot be created from a console or an API — it only comes from a person
 * signing in and pressing Allow. Everything either side of that press is
 * mechanical, so this does the mechanical parts and leaves the press.
 *
 * Nothing is written to disk and nothing leaves this machine except the
 * exchange with Google. The token is printed once; if the terminal is shared,
 * clear it afterwards.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";

const [clientId, clientSecret] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/google-ads-refresh-token.mjs <client-id> <client-secret>");
  console.error("");
  console.error("Get both from Google Cloud Console:");
  console.error("  APIs & Services -> Credentials -> Create credentials -> OAuth client ID");
  console.error("  Application type: Web application");
  console.error("  Authorised redirect URI: http://localhost:8787/callback");
  process.exit(1);
}

/** Must match the redirect URI registered on the OAuth client, exactly. */
const PORT = 8787;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/adwords";

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    // Both are required to get a refresh token at all: `offline` asks for one,
    // and `consent` forces the prompt even for an account that has approved
    // this client before — without it Google returns an access token only and
    // the whole exercise silently produces nothing usable.
    access_type: "offline",
    prompt: "consent",
  }).toString();

/** Opens the browser where it can, and always prints the URL as the fallback. */
function openBrowser(url) {
  const command =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Printed below regardless.
  }
}

async function exchange(code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });

  const body = await response.json();
  if (!response.ok || !body.refresh_token) {
    console.error("\nThat did not work. Google said:");
    console.error(JSON.stringify(body, null, 2));
    if (body.error === "redirect_uri_mismatch") {
      console.error(`\nThe OAuth client needs "${REDIRECT_URI}" as an authorised redirect URI, character for character.`);
    }
    if (response.ok && !body.refresh_token) {
      console.error("\nGoogle returned an access token but no refresh token. That happens when the");
      console.error("account has approved this client before; this script already sends prompt=consent,");
      console.error("so if you see it, remove the app at myaccount.google.com/permissions and run it again.");
    }
    return false;
  }

  console.log("\nDone. Put these three in Coolify, then redeploy the worker:\n");
  console.log(`GOOGLE_ADS_CLIENT_ID=${clientId}`);
  console.log(`GOOGLE_ADS_CLIENT_SECRET=${clientSecret}`);
  console.log(`GOOGLE_ADS_REFRESH_TOKEN=${body.refresh_token}`);
  console.log("\nGOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_LOGIN_CUSTOMER_ID stay as they are.");
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    response.writeHead(404).end("Not here.");
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error || !code) {
    response.writeHead(400, { "content-type": "text/html" })
      .end(`<p>Google said: ${error ?? "no code"}. You can close this tab.</p>`);
    console.error(`\nGoogle refused: ${error ?? "no code returned"}`);
    server.close();
    process.exit(1);
  }

  const ok = await exchange(code);
  response.writeHead(200, { "content-type": "text/html" }).end(
    ok
      ? "<p>Done. Go back to the terminal for the three values.</p>"
      : "<p>That did not work. The terminal has the reason.</p>",
  );
  server.close();
  process.exit(ok ? 0 : 1);
});

server.listen(PORT, () => {
  console.log("Sign in as the Google account that can see the Ads account.\n");
  console.log("If a browser does not open, paste this in:\n");
  console.log(authUrl);
  console.log("\nWaiting for you to press Allow...");
  openBrowser(authUrl);
});
