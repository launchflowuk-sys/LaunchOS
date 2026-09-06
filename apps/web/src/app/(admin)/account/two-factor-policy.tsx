"use client";

import { useActionState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { setTeamTwoFactorPolicyAction, type TwoFactorPolicyState } from "./actions";

const INITIAL: TwoFactorPolicyState = { status: "idle" };

/**
 * The owner-only switch that turns the second factor from an option into a
 * condition of using the admin portal.
 *
 * It says the number out loud before it is thrown: `pending` is the count of
 * active members who have not enrolled, and every one of them lands on this
 * screen and nowhere else the moment it goes on. The refusal that stops an
 * unenrolled owner switching it on comes back from the action as a sentence.
 *
 * Clients are never covered by it, which is worth saying on the screen: a
 * client locked out of the portal is a support request, and there is nobody
 * behind them to let them back in.
 */
export function TwoFactorPolicySwitch({ required, pending }: { required: boolean; pending: number }) {
  const [state, formAction, saving] = useActionState(setTeamTwoFactorPolicyAction, INITIAL);

  return (
    <form action={formAction} aria-label="Two-factor requirement" className="space-y-4">
      <input type="hidden" name="required" value={required ? "off" : "on"} />

      <p className="text-sm text-muted-foreground">
        {required
          ? "Every owner and staff account must hold a second factor. Anyone who has not set one up is sent here until they do. Client portal accounts are not affected."
          : "Two-factor is optional for the team at the moment. Turning this on sends every owner and staff account here until they have set one up. Client portal accounts are never covered."}
      </p>

      {!required && pending > 0 ? (
        <InlineAlert tone="warning">
          {pending === 1
            ? "One active member has not set up a second factor yet. They will be sent here to do it before they can use anything else."
            : `${pending} active members have not set up a second factor yet. They will be sent here to do it before they can use anything else.`}
        </InlineAlert>
      ) : null}

      {state.status === "error" ? <InlineAlert tone="danger">{state.message}</InlineAlert> : null}

      {state.status === "saved" ? (
        <div role="status">
          <InlineAlert tone="success">
            {state.required ? "Two-factor is now required for the team." : "Two-factor is optional for the team again."}
          </InlineAlert>
        </div>
      ) : null}

      <Button type="submit" variant={required ? "destructive-quiet" : "primary"} loading={saving}>
        {required ? "Stop requiring two-factor" : "Require two-factor for the team"}
      </Button>
    </form>
  );
}
