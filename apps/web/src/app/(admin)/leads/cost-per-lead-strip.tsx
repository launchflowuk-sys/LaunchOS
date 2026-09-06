import type { CampaignCostPerLead, CostPerLeadReport } from "@launchos/core";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { Section } from "@/components/section";
import { formatPence } from "@/lib/format";

/**
 * What an enquiry costs, campaign by campaign.
 *
 * The screen's job is to be honest about a join that can only ever be partly
 * complete. A lead carries whatever `utm_campaign` the landing URL set; the ad
 * platforms report spend against a campaign they name themselves; and plenty
 * of leads — a phone call, a referral, somebody who typed the address in —
 * carry nothing at all.
 *
 * So: a missing side is a dash, never a zero. Leads with no campaign get their
 * own row rather than being folded into one. Spend that produced no enquiry
 * keeps its own row too, because that is the most useful line here. And the
 * sentence under the table says what fraction of each side actually met, so
 * nobody reads a number over half the data as if it were the whole picture.
 */

const COLUMNS: readonly DataListColumn<CampaignCostPerLead>[] = [
  {
    key: "campaign",
    header: "Campaign",
    primary: true,
    cell: (row) =>
      row.campaign === null ? (
        <>
          No campaign
          <span className="block text-meta font-normal text-muted-foreground">
            Phone calls, referrals, anyone who typed the address in
          </span>
        </>
      ) : (
        <Link href={{ pathname: "/leads", query: { campaign: row.campaign } }} className="hover:underline">
          {row.campaign}
        </Link>
      ),
  },
  { key: "leads", header: "Leads", className: "tabular-nums", cell: (row) => row.leads },
  {
    key: "spend",
    header: "Spend",
    className: "tabular-nums",
    cell: (row) => (row.spendPence === null ? <Dash title="No ad spend matched this campaign" /> : formatPence(row.spendPence)),
  },
  {
    key: "cpl",
    header: "Cost per lead",
    className: "tabular-nums",
    cell: (row) =>
      row.costPerLeadPence === null ? (
        <Dash title={row.leads === 0 ? "This campaign produced no enquiries" : "No ad spend matched this campaign"} />
      ) : (
        <span className="font-semibold">{formatPence(row.costPerLeadPence)}</span>
      ),
  },
  { key: "converted", header: "Won", className: "tabular-nums", cell: (row) => row.converted },
];

function Dash({ title }: { title: string }) {
  return (
    <span className="text-muted-foreground" title={title}>
      —
    </span>
  );
}

export function CostPerLeadStrip({ report, days }: { report: CostPerLeadReport; days: number }) {
  const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

  return (
    <Section
      title="Cost per lead"
      description={`Leads against the ad spend that bought them, by campaign, over the last ${days} days.`}
    >
      <DataList
        rows={report.rows}
        columns={COLUMNS}
        getRowKey={(row) => row.campaign ?? "__none"}
        caption="Cost per lead by campaign"
        empty={<p className="text-sm text-muted-foreground">No leads and no ad spend in this period.</p>}
      />
      <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
        {report.attributedLeads} of {report.totalLeads} leads ({percent(report.attributedLeads, report.totalLeads)}%) carried a campaign,
        and {report.matchedLeads} of those matched ad spend we have figures for. {formatPence(report.placedSpendPence)} of{" "}
        {formatPence(report.accountSpendPence)} of spend in this period is placed against a campaign that produced a lead — the rest went
        to campaigns nobody enquired from, or to accounts whose campaign breakdown we do not hold. Read every cost per lead as a floor,
        not a fact.
      </p>
    </Section>
  );
}
