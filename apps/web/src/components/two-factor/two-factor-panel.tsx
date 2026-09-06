"use client";

import { KeyRound, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { BackupCodes } from "./backup-codes";
import { QrCode } from "./qr-code";

/** What the person is being asked for their password in order to do. */
type Intent = "enable" | "regenerate" | "disable";

type Stage =
  | { name: "resting" }
  | { name: "password"; intent: Intent }
  | { name: "scan"; totpURI: string; codes: readonly string[] }
  | { name: "codes"; codes: readonly string[] };

const ASKS: Record<Intent, { legend: string; submit: string; note: string }> = {
  enable: {
    legend: "Confirm your password to start",
    submit: "Continue",
    note: "We ask again here so a session somebody else is holding cannot enrol a device of their own.",
  },
  regenerate: {
    legend: "Confirm your password to replace your codes",
    submit: "Replace codes",
    note: "Your current codes stop working the moment the new ones appear.",
  },
  disable: {
    legend: "Confirm your password to turn two-factor off",
    submit: "Turn off two-factor",
    note: "A live session is not enough on its own — a laptop somebody walked off with must not be able to do this.",
  },
};

/** The shared secret, for an authenticator that cannot use a camera. */
function manualKey(totpURI: string): string | null {
  try {
    return new URL(totpURI).searchParams.get("secret");
  } catch {
    return null;
  }
}

function message(error: { message?: string | undefined } | null, fallback: string): string {
  return error?.message || fallback;
}

/**
 * Enrolment, replacement and removal of a TOTP second factor, for one account.
 *
 * The same panel serves staff on `/account` and clients on
 * `/portal/account` — the operations are identical and only the surrounding
 * copy differs, so `enforced` is the single prop that changes tone.
 *
 * Every call goes to Better Auth's own endpoints from the browser rather than
 * through a server action. That is deliberate: enabling and disabling rotate
 * the session cookie, and a server action cannot hand a rotated cookie back to
 * the browser, so routing them through one would sign the person out by the
 * act of protecting their account. The password checks and every audit write
 * still happen server-side, inside the auth layer, where no form can skip them.
 */
export function TwoFactorPanel({
  enabled,
  enforced = false,
}: {
  enabled: boolean;
  /** True when this account's organisation requires a second factor. */
  enforced?: boolean;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ name: "resting" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset(next: Stage) {
    setPassword("");
    setCode("");
    setError(null);
    setStage(next);
  }

  async function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage.name !== "password") return;
    setPending(true);
    setError(null);
    const { intent } = stage;

    if (intent === "enable") {
      const { data, error: failed } = await authClient.twoFactor.enable({ password });
      setPending(false);
      if (failed || !data || !("totpURI" in data) || !data.totpURI || !data.backupCodes) {
        setError(message(failed, "That password was not accepted."));
        return;
      }
      setPassword("");
      setStage({ name: "scan", totpURI: data.totpURI, codes: data.backupCodes });
      return;
    }

    if (intent === "regenerate") {
      const { data, error: failed } = await authClient.twoFactor.generateBackupCodes({ password });
      setPending(false);
      if (failed || !data?.backupCodes) {
        setError(message(failed, "That password was not accepted."));
        return;
      }
      setPassword("");
      setStage({ name: "codes", codes: data.backupCodes });
      return;
    }

    const { error: failed } = await authClient.twoFactor.disable({ password });
    setPending(false);
    if (failed) {
      setError(message(failed, "That password was not accepted."));
      return;
    }
    reset({ name: "resting" });
    router.refresh();
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage.name !== "scan") return;
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
    setPending(false);
    if (failed) {
      setError(message(failed, "That code was not right. Check your phone's clock and try the next one."));
      return;
    }
    // Only now is the factor live. The codes came back with the secret and
    // have never been anywhere but this tab's memory.
    setStage({ name: "codes", codes: stage.codes });
    setCode("");
    router.refresh();
  }

  if (stage.name === "codes") {
    return (
      <BackupCodes
        codes={stage.codes}
        onDone={() => {
          reset({ name: "resting" });
          router.refresh();
        }}
      />
    );
  }

  if (stage.name === "scan") {
    const key = manualKey(stage.totpURI);
    return (
      <form onSubmit={submitCode} aria-label="Confirm your authenticator" className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Scan this with Google Authenticator, 1Password, Authy or any other authenticator app, then type the six
          digits it shows.
        </p>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <QrCode value={stage.totpURI} label="Two-factor set-up code" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-label">Or enter this key by hand</p>
            <p className="break-all font-mono text-sm">{key ?? "—"}</p>
            <p className="text-meta text-muted-foreground">Time-based, six digits, thirty seconds.</p>
          </div>
        </div>

        <div className="max-w-[14rem] space-y-1.5">
          <Label htmlFor="totp-code">Code from your app</Label>
          <Input
            id="totp-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="h-11 font-mono text-base tracking-[0.3em]"
          />
        </div>

        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" loading={pending}>
            Turn on two-factor
          </Button>
          <Button type="button" variant="ghost" onClick={() => reset({ name: "resting" })}>
            Cancel
          </Button>
        </div>
        <p className="text-meta text-muted-foreground">
          Nothing changes about how you sign in until this code is accepted, so a cancelled set-up cannot lock you out.
        </p>
      </form>
    );
  }

  if (stage.name === "password") {
    const ask = ASKS[stage.intent];
    return (
      <form onSubmit={submitPassword} aria-label={ask.legend} className="max-w-sm space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="two-factor-password">{ask.legend}</Label>
          <Input
            id="two-factor-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            suppressHydrationWarning
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="text-meta text-muted-foreground">{ask.note}</p>
        </div>

        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" variant={stage.intent === "disable" ? "destructive" : "primary"} loading={pending}>
            {ask.submit}
          </Button>
          <Button type="button" variant="ghost" onClick={() => reset({ name: "resting" })}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  if (!enabled) {
    return (
      <div className="space-y-4">
        {enforced ? (
          <InlineAlert tone="warning" title="Required on this account">
            Your organisation requires a second factor on staff accounts. Set one up to get back to the rest of the
            portal.
          </InlineAlert>
        ) : null}
        <p className="text-sm text-muted-foreground">
          A six-digit code from an app on your phone, on top of your password. Set it up once and you will be asked for
          a code each time you sign in on a new browser.
        </p>
        <Button type="button" onClick={() => reset({ name: "password", intent: "enable" })}>
          <ShieldCheck aria-hidden strokeWidth={1.75} />
          Set up two-factor
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <InlineAlert tone="success" title="Two-factor is on">
        You are asked for a code from your authenticator app every time you sign in.
      </InlineAlert>
      <p className="text-sm text-muted-foreground">
        Lost your phone? Sign in with one of your backup codes, then replace the set. Both of these need your password.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="secondary" onClick={() => reset({ name: "password", intent: "regenerate" })}>
          <KeyRound aria-hidden strokeWidth={1.75} />
          Replace backup codes
        </Button>
        <Button
          type="button"
          variant="destructive-quiet"
          onClick={() => reset({ name: "password", intent: "disable" })}
        >
          Turn off two-factor
        </Button>
      </div>
    </div>
  );
}
