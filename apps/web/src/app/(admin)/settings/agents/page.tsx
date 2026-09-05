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
        category="automation"
      />

      <ul className="grid min-w-0 gap-4">
        {agentCatalog().map((agent) => {
          const enabled = enabledByKey.get(agent.key) ?? false;
          return (
            <li key={agent.key} className="min-w-0 rounded-xl border bg-card p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <p className="text-base font-semibold">{agent.name}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{agent.description}</p>
                  <p className="mt-1 font-mono text-meta text-muted-foreground">
                    {agent.key} · {agent.trigger}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 max-sm:justify-between">
                  <StatusBadge value={enabled ? "enabled" : "disabled"} tone={enabled ? "success" : "neutral"} />
                  <form action={setAgentEnabled}>
                    <input type="hidden" name="agentKey" value={agent.key} />
                    <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
                    <Button type="submit" variant={enabled ? "secondary" : "primary"} size="sm">
                      {enabled ? "Disable" : "Enable"}
                    </Button>
                  </form>
                </div>
              </div>

              <p className="label-caps mt-4 text-muted-foreground">Tools</p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {agent.tools.map((tool) => (
                  <li
                    key={tool.name}
                    title={tool.requiresApproval ? "Needs approval before it acts" : "Runs without approval"}
                    className={
                      tool.requiresApproval
                        ? "rounded-md border border-warning-border bg-warning-bg px-2 py-0.5 font-mono text-meta text-warning-fg"
                        : "rounded-md border bg-muted px-2 py-0.5 font-mono text-meta text-muted-foreground"
                    }
                  >
                    {tool.name}
                    {tool.requiresApproval ? " · needs approval" : null}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </>
  );
}
