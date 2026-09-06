"use client";

import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * The browser half of Better Auth. The two-factor plugin adds
 * `authClient.twoFactor.*` and, on a sign-in that still owes a code, turns the
 * response into `{ twoFactorRedirect: true }` instead of a session.
 *
 * No `twoFactorPage` or `onTwoFactorRedirect` is configured on purpose: both
 * navigate with `window.location`, which would race the sign-in form's own
 * `router.push`. The form reads the flag off the response and routes itself.
 */
export const authClient = createAuthClient({ plugins: [twoFactorClient()] });
