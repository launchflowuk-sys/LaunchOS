import { listMembers } from "@launchos/core";
import { UsersRound } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { deactivateMemberAction } from "./actions";
import { AddMemberDialog } from "./add-member-dialog";
import { ReissuePasswordDialog } from "./reissue-password-dialog";

export const dynamic = "force-dynamic";

type Member = Awaited<ReturnType<typeof listMembers>>[number];

function columns(isOwner: boolean, currentUserId: string): readonly DataListColumn<Member>[] {
  return [
    {
      key: "member",
      header: "Member",
      primary: true,
      cell: (member) => (
        <>
          {member.displayName ?? member.name}
          {member.title ? (
            <span className="block text-meta font-normal text-muted-foreground">{member.title}</span>
          ) : null}
        </>
      ),
    },
    { key: "email", header: "Email", cell: (member) => member.email },
    { key: "role", header: "Role", cell: (member) => <span className="capitalize">{member.role}</span> },
    {
      key: "added",
      header: "Added",
      hideOnMobile: true,
      cell: (member) => <span className="whitespace-nowrap">{formatDateTime(member.createdAt)}</span>,
    },
    { key: "status", header: "Status", status: true, cell: (member) => <StatusBadge value={member.status} /> },
    {
      key: "actions",
      header: "Actions",
      action: true,
      // No `flex-wrap` on the row below: inside a table cell the two controls
      // wrapped onto two lines and doubled the height of every row.
      cell: (member) => (
        <div className="flex items-center justify-end gap-2 max-sm:flex-col max-sm:[&>*]:w-full">
          {/* `active` only: an `invited` row is a membership nobody has
              completed, and it is completed by adding the member again —
              never here, which would mint a credential the invite path
              then refuses to step over, stranding the account for good.
              `initialPasswordSetAt === null` means the member is still on
              the password an owner issued them, so there is nothing of
              their own to overwrite. Once they set their own, this goes. */}
          {isOwner && member.status === "active" && member.initialPasswordSetAt === null ? (
            <ReissuePasswordDialog memberId={member.id} name={member.displayName ?? member.name} />
          ) : null}
          {isOwner && member.status === "active" && member.userId !== currentUserId ? (
            <form action={deactivateMemberAction} className="max-sm:w-full">
              <input type="hidden" name="memberId" value={member.id} />
              {/* Danger ink on a bordered button rather than the solid
                  `destructive` fill: a team list is a dozen rows deep, and a
                  dozen full-width red bars is an alarm about nothing. The solid
                  red is kept for the one-off destructive action on a detail
                  screen — Void an invoice, Delete a template. */}
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                className="max-sm:w-full text-danger-fg hover:bg-danger-bg hover:text-danger-fg"
              >
                Deactivate
              </Button>
            </form>
          ) : null}
        </div>
      ),
    },
  ];
}

export default async function TeamPage() {
  const session = await requireAdmin();
  const members = await listMembers(getDb(), session.organisationId);
  const isOwner = session.role === "owner";

  return (
    <>
      <PageHeader
        title="Team"
        description="People who can sign in and be assigned work. Sign-up is disabled: accounts are created here."
        category="organisation"
        actions={isOwner ? <AddMemberDialog /> : null}
      />

      <DataList<Member>
        rows={members}
        columns={columns(isOwner, session.userId)}
        getRowKey={(member) => member.id}
        caption="Team members"
        empty={<EmptyState icon={UsersRound}>No members yet.</EmptyState>}
      />
    </>
  );
}
