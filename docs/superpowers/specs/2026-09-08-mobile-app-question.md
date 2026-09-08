# A mobile app, or a mobile web app?

**Status: asked, deliberately not answered yet.** Shoji raised this on 8 Sep
2026 and said explicitly: talk about it *after* the platform redesign is
finished. This file exists so the question and its constraints survive until
then, not to settle it.

## What he asked for

A companion app for iOS and Android that shows "an exact UI, every single
thing possible":

- Splash screen with the LaunchFlow logo animated for a few seconds
- Login for admin and staff
- A sign-up button — deliberately simple: **email and password, verified by a
  six-digit code**. Nothing fancy, no social login.
- Everything he can do in the dashboard, doable in the app

## His own doubt, which is the important part

In his words: *"doing everything in the dashboard means basically my mobile
viewport will be put into an expo app which is basically double work — so tell
me whether an app is necessary or not, because if we can nail the mobile
viewport design with every section optimised it will be amazing."*

He has already identified the real trade-off. The question is not "can we build
an app" but "does a second codebase earn its keep against a mobile web app that
is genuinely designed rather than merely responsive".

## What has to be true before this is answerable

- **The redesign has to land first.** If every screen gets real mobile design
  as part of it — not a squeezed desktop table — then much of the app's value
  is already delivered and the answer changes.
- **He needs to have used it on a phone for a while.** The same rule as phases
  5 and 6 of the Mr. Green plan: he will find the gaps by using it, and the
  gaps are the specification.

## Facts that will bear on it, gathered now so they are not re-derived

- Expo is already in his toolchain — Cabio ships iOS and Android through it,
  and the Grays Park Masjid companion app is being built the same way. So the
  cost of an app is not "learn a new stack".
- **Push notifications are the one thing a web app genuinely cannot match** on
  iOS, and notify-by-exception (Mr. Green spec point 13) is a phase-5 feature
  that would land straight into it. That is the strongest argument for an app
  and it should be weighed honestly rather than dismissed.
- LaunchOS already has a web-push adapter behind `VAPID_*`, which works on
  Android and on iOS only for an installed PWA. That is the middle path and it
  deserves testing before a second codebase is committed to.
- Everything the API needs already exists: phases 1–4 of the v1 API are live,
  read-only, token-authenticated. An app would consume that rather than needing
  anything new built for it.

## Decision owner

Shoji. Revisit when the redesign is finished.
