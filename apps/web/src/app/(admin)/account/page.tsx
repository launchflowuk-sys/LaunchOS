import { listMembers } from "@launchos/core";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";

/**
 * The staff half of the portal's `/portal/account`: the one screen a signed-in
 * owner or staff member can change their own password on.
 *
 * It matters more here than it reads. Sign-up is disabled and there is no
 * self-service reset, so every staff account starts on a one-time password an
 * owner read off a dialog and sent them. Without this screen there was no path
 * off it, and `organisation_members.initial_password_set_at` — the column that
 * decides whether an owner may still re-issue over the top of that credential —
 * could never be stamped.
 */
export default async function AccountPage() {
  const session = await requireAdmin();
  const me = (await listMembers(getDb(), session.organisationId)).find((m) => m.userId === session.userId);

  return (
    <>
      <PageHeader title="Account" description="Your own sign-in details for this organisation." />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Signed in as</h2>
        <div className="rounded-lg border border-neutral-200 bg-white p-5 text-sm">
          <p className="font-medium text-neutral-900">{me?.displayName ?? me?.name ?? session.email}</p>
          <p className="mt-1 text-neutral-600">{session.email}</p>
          <p className="mt-1 text-xs capitalize text-neutral-500">{session.role}</p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Password</h2>
        <div className="rounded-lg border border-neutral-200 bg-white p-5">
          {me && me.initialPasswordSetAt === null ? (
            <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              You are still on the password you were issued. Change it here — until you do, an owner can re-issue a new
              one over the top of it from the Team screen.
            </p>
          ) : null}
          {me?.initialPasswordSetAt ? (
            <p className="mb-4 text-xs text-neutral-500">
              You set your own password on {formatDateTime(me.initialPasswordSetAt)}.
            </p>
          ) : null}
          <ChangePasswordForm />
        </div>
      </section>
    </>
  );
}
