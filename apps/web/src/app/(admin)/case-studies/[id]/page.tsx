import { getCaseStudy, getClient, getProjectRow } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdminWith } from "@/lib/permissions";
import { uuidOr404 } from "@/lib/uuid-route";
import { CaseStudyStatusBadge, DeliveryStatusBadge } from "../case-study-status-badge";
import { CaseStudyForm } from "./case-study-form";

export const dynamic = "force-dynamic";

export default async function CaseStudyDetailPage({ params }: PageProps<"/case-studies/[id]">) {
  const id = uuidOr404((await params).id);
  const session = await requireAdminWith("content");
  const db = getDb();

  const study = await getCaseStudy(db, session.organisationId, id);
  if (!study) notFound();

  const [client, project] = await Promise.all([
    study.clientId ? getClient(db, session.organisationId, study.clientId) : null,
    study.projectId ? getProjectRow(db, session.organisationId, study.projectId) : null,
  ]);

  return (
    <>
      <PageHeader
        title={study.name}
        description={study.summary || "No one-line summary yet."}
        category="delivery"
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <CaseStudyStatusBadge status={study.status} />
            <DeliveryStatusBadge status={study.deliveryStatus} />
          </div>
        }
      />

      <KeyValue
        className="mb-6"
        columns={2}
        items={[
          {
            label: "Public page",
            value:
              study.status === "published" ? (
                <Link href={`/site/work/${study.slug}`} className="break-all hover:underline">
                  /work/{study.slug}
                </Link>
              ) : (
                <span className="text-muted-foreground">Not published — /work/{study.slug} when it is</span>
              ),
          },
          {
            label: "Client",
            value: client ? <Link href={`/clients/${client.id}`} className="hover:underline">{client.name}</Link> : "Not linked to a client",
          },
          {
            label: "Project",
            value: project ? <Link href={`/projects/${project.id}`} className="hover:underline">{project.name}</Link> : "Not linked to a project",
          },
          {
            label: "First published",
            value: study.publishedAt ? formatDateTime(study.publishedAt) : "Never",
            ...(study.publishedAt
              ? { hint: "Kept from the first publish — taking a story down to fix a line does not make it look new." }
              : {}),
          },
        ]}
      />

      <Section
        title="The story"
        description="Ours to edit for ever: nobody signed it, and the point of publishing from a table is that a typo can be fixed on a Sunday without a deploy."
      >
        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <CaseStudyForm study={study} />
        </div>
      </Section>
    </>
  );
}
