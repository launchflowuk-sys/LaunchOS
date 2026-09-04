import { listMembers } from "@launchos/core";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { deactivateMemberAction } from "./actions";
import { AddMemberDialog } from "./add-member-dialog";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const session = await requireAdmin();
  const members = await listMembers(getDb(), session.organisationId);
  const isOwner = session.role === "owner";

  return (
    <>
      <PageHeader
        title="Team"
        description="People who can sign in and be assigned work. Sign-up is disabled: accounts are created here."
        actions={isOwner ? <AddMemberDialog /> : null}
      />

      {members.length === 0 ? (
        <EmptyState>No members yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium text-neutral-900">
                    {member.displayName ?? member.name}
                    {member.title ? <span className="block text-xs text-neutral-400">{member.title}</span> : null}
                  </TableCell>
                  <TableCell className="text-neutral-600">{member.email}</TableCell>
                  <TableCell className="capitalize text-neutral-600">{member.role}</TableCell>
                  <TableCell>
                    <StatusBadge value={member.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(member.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {isOwner && member.status === "active" && member.userId !== session.userId ? (
                      <form action={deactivateMemberAction}>
                        <input type="hidden" name="memberId" value={member.id} />
                        <button type="submit" className="text-xs text-neutral-500 hover:text-red-600">
                          Deactivate
                        </button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
