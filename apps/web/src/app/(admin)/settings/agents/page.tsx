import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { agentCatalog } from "@/lib/agent-catalog";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { setAgentEnabled } from "./actions";

export const dynamic = "force-dynamic";

export default async function AgentSettingsPage() {
  const session = await requireAdmin();

  const rows = await getDb()
    .select()
    .from(schema.agentEnablement)
    .where(eq(schema.agentEnablement.organisationId, session.organisationId));

  const enabledByKey = new Map(rows.map((row) => [row.agentKey, row.enabled]));

  return (
    <>
      <PageHeader
        title="Agents"
        description="Which autonomous agents run for this organisation. Every agent registered in this build is listed; a tool marked Needs approval never acts without a decision on /approvals."
      />

      <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {agentCatalog().map((agent) => {
          const enabled = enabledByKey.get(agent.key) ?? false;
          return (
            <li key={agent.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900">{agent.name}</p>
                <p className="mt-0.5 text-sm text-neutral-600">{agent.description}</p>
                <p className="font-mono text-xs text-neutral-400">
                  {agent.key} · {agent.trigger}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {agent.tools.map((tool) => (
                    <li
                      key={tool.name}
                      title={tool.requiresApproval ? "Needs approval before it acts" : "Runs without approval"}
                      className={
                        tool.requiresApproval
                          ? "rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-800"
                          : "rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
                      }
                    >
                      {tool.name}
                      {tool.requiresApproval ? " · needs approval" : null}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <StatusBadge value={enabled ? "enabled" : "disabled"} tone={enabled ? "success" : "neutral"} />
                <form action={setAgentEnabled}>
                  <input type="hidden" name="agentKey" value={agent.key} />
                  <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
                  <Button type="submit" variant={enabled ? "secondary" : "primary"}>
                    {enabled ? "Disable" : "Enable"}
                  </Button>
                </form>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
