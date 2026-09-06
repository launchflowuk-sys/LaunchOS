import { ACCESS_PORTAL_PATH, getPublicDeliveryReport, projectUpdateRecipients } from "@launchos/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InlineAlert } from "@/components/inline-alert";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { PublicShell } from "../../(marketing)/site/_components/public-shell";
import { DeliveryBody } from "./delivery-body";
import { SignOffPanel } from "./sign-off-panel";

/**
 * A finished build, read and signed off by whoever holds its link.
 *
 * The same shape as `/p/[token]` in every respect that matters, because it is
 * the same job at the other end of it: public and unauthenticated by position
 * (outside `(admin)` and `(portal)`, so neither shell's `require*` runs),
 * passed through by the proxy so it answers on the marketing host and the app
 * host alike, and **the token is the only key** — every core call below takes
 * it rather than an id, so there is nothing here a caller could guess.
 *
 * A token that matches nothing and a project that has never had a report
 * rendered both get the same plain 404: no page, no explanation, nothing that
 * says which. A project that exists but cannot be signed off gets one
 * sentence that does not say why either.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your handover — LaunchFlow",
  description: "Read the handover for your finished build and sign it off.",
  // Never indexed and never followed: the URL is the authorisation.
  robots: { index: false, follow: false, nocache: true },
};

export default async function PublicDeliveryPage({ params }: PageProps<"/d/[token]">) {
  const { token } = await params;
  const report = await getPublicDeliveryReport(getDb(), token);
  if (!report) notFound();

  const { project, clientName, signOff } = report;
  // Cancelled is the one state core refuses outright. Everything else is
  // signable: a build whose last step is still open is exactly the build a
  // client is being asked to look at.
  const signable = signOff === null && project.status !== "cancelled";

  // Their own address, so they do not have to type it on a phone. The token
  // is already proof of who is reading; this adds nothing to it.
  const [recipient] = await projectUpdateRecipients(getDb(), project.organisationId, project.clientId);
  const portalUrl = `${process.env.APP_URL ?? "http://localhost:3000"}${ACCESS_PORTAL_PATH}`;

  return (
    <PublicShell
      title={`${project.name} — your handover`}
      description={
        signOff
          ? `Signed off on ${formatDate(signOff.signedAt)}. This page is the record of it.`
          : `What we built for ${clientName}, where it lives, and what we look after from here.`
      }
    >
      <div className="mx-auto grid max-w-3xl gap-10">
        {signOff ? (
          <InlineAlert tone="success" title="You signed this off">
            {`Signed by ${signOff.signedName} on ${formatDate(signOff.signedAt)}. Your care plan has started, and a signed copy is on its way to ${signOff.signedEmail}.`}
          </InlineAlert>
        ) : null}

        {signable || signOff ? null : (
          <InlineAlert tone="warning" title="This handover is not open for sign-off">
            Reply to the email this link came in and we will sort it out.
          </InlineAlert>
        )}

        <DeliveryBody report={report} portalUrl={portalUrl} />

        {signable ? <SignOffPanel token={token} defaults={{ name: "", email: recipient ?? "" }} /> : null}

        <p className="text-center text-sm" style={{ color: "var(--mute)" }}>
          Something in here not right? Reply to the email this link came in and we will put it right before you sign.
        </p>
      </div>
    </PublicShell>
  );
}
