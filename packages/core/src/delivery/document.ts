import { escapeHtml } from "@launchos/channels";
import { DOCUMENT_MARGIN, renderDocumentHtml, type RenderPdfInput } from "@launchos/channels/pdf";
import type { Db } from "@launchos/db";
import { ACCESS_PORTAL_PATH } from "../access/access-entries.js";
import { appUrl } from "../config.js";
import { signatureSvgMarkup } from "../documents/acceptance.js";
import { ukLongDate } from "../tasks/dates.js";
import { buildDeliveryReport, type DeliveryReport } from "./report.js";
import type { DeliverySignOffRow } from "./shared.js";

/**
 * The delivery report on LaunchFlow's headed paper.
 *
 * Same rules as `proposals/document.ts`, for the same reasons: the chrome
 * belongs to `packages/channels/src/pdf/document.ts` and is shared with every
 * other document kind, this file supplies a body, and **everything dynamic is
 * escaped**. The signature is the single exception and is built by
 * `signatureSvgMarkup` from path data already matched against the SVG path
 * grammar.
 *
 * The Access section is the reason this document needs reading carefully. It
 * prints the *name* of each way in and, where it is a public address, the
 * address — and nothing else. There is no branch here that could print a
 * password, because `buildDeliveryReport` was never handed one: the query
 * behind `access` selects neither the ciphertext, nor the username, nor the
 * notes. A PDF is emailed, forwarded and left in an inbox for years; it is the
 * worst possible home for a credential, and the way to be sure it never
 * carries one is for the data not to be in the room.
 */

/** The reference printed in the footer and quoted on the phone. */
export function deliveryReportReference(project: { id: string }): string {
  return `D-${project.id.slice(0, 8).toUpperCase()}`;
}

/** The document's title, at the top of page one and in the PDF's own metadata. */
export function deliveryReportTitle(report: Pick<DeliveryReport, "project" | "signOff">): string {
  return report.signOff ? `${report.project.name} — handover, signed off` : `${report.project.name} — handover`;
}

function paragraphsHtml(text: string | null): string {
  if (!text?.trim()) return "";
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block.trim()).replace(/\r?\n/g, "<br />")}</p>`)
    .join("");
}

function listHtml(heading: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return `<h2>${escapeHtml(heading)}</h2><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

/** What was built: the spine, with the steps that were skipped left out. */
function phasesHtml(report: DeliveryReport): string {
  const rows = report.phases
    .filter((phase) => phase.status !== "skipped")
    .map((phase) => {
      const when = phase.doneAt ? ukLongDate(phase.doneAt) : phase.status === "done" ? "Done" : "In progress";
      return `<tr><td>${escapeHtml(phase.name)}</td><td class="numeric">${escapeHtml(when)}</td></tr>`;
    })
    .join("");
  if (!rows) return "";
  return `<h2>What we built</h2><table><tbody>${rows}</tbody></table>`;
}

/** The promises kept, with the ones still open shown honestly as still open. */
function milestonesHtml(report: DeliveryReport): string {
  if (report.milestones.length === 0) return "";
  const rows = report.milestones
    .map((milestone) => {
      const when = milestone.reachedAt ? ukLongDate(milestone.reachedAt) : "Still to come";
      const detail = milestone.detail?.trim() ? `<br /><span class="muted">${escapeHtml(milestone.detail.trim())}</span>` : "";
      return `<tr><td>${escapeHtml(milestone.title)}${detail}</td><td class="numeric">${escapeHtml(when)}</td></tr>`;
    })
    .join("");
  return `<h2>Milestones</h2><table><tbody>${rows}</tbody></table>`;
}

function sitesHtml(report: DeliveryReport): string {
  if (report.sites.length === 0) return "";
  const rows = report.sites
    .map((site) => `<tr><td>${escapeHtml(site.name)}</td><td>${escapeHtml(site.url)}</td><td class="numeric">${site.live ? "Live" : "Not live yet"}</td></tr>`)
    .join("");
  return `<h2>Where it lives</h2><table><tbody>${rows}</tbody></table>`;
}

/**
 * Where the logins live — the section this whole document is careful about.
 *
 * One row per way in: what it is, what it is called, and the address if there
 * is a public one. `hasSecret` prints as the sentence "we hold the password",
 * which is the true and complete statement a client needs; the password
 * itself is in the vault, encrypted, and every look at it is recorded against
 * a named person.
 */
function accessHtml(report: DeliveryReport, env: NodeJS.ProcessEnv): string {
  if (report.access.length === 0) return "";
  const rows = report.access
    .map((entry) => {
      const where = entry.url ?? entry.host ?? "—";
      const held = entry.hasSecret ? "We hold the password" : "No password held";
      const site = entry.siteName ? ` (${entry.siteName})` : "";
      return `<tr><td>${escapeHtml(entry.kindLabel)}</td><td>${escapeHtml(entry.label + site)}</td><td>${escapeHtml(where)}</td><td class="numeric">${escapeHtml(held)}</td></tr>`;
    })
    .join("");
  const portal = `${appUrl(env)}${ACCESS_PORTAL_PATH}`;
  return `<h2>Your logins</h2>
    <p>These are the accounts and machines your website runs on. <strong>No password is printed in this document</strong> — they are held encrypted in LaunchFlow, and every time one of us looks at one it is recorded with our name and the date. Ask through your portal at ${escapeHtml(portal)} and we will hand any of them over.</p>
    <table><tbody>${rows}</tbody></table>`;
}

function monitoringHtml(report: DeliveryReport): string {
  if (report.monitors.length === 0) return "";
  const rows = report.monitors
    .map((monitor) => {
      const minutes = Math.max(1, Math.round(monitor.intervalSeconds / 60));
      const often = minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
      return `<tr><td>${escapeHtml(monitor.siteName)}</td><td>${escapeHtml(monitor.target)}</td><td class="numeric">${escapeHtml(often)}</td></tr>`;
    })
    .join("");
  return `<h2>What we watch</h2>
    <p>If any of these stops answering we are told automatically, and we start looking before you have to tell us.</p>
    <table><tbody>${rows}</tbody></table>`;
}

function careHtml(report: DeliveryReport): string {
  if (!report.care) return "";
  const covers = listHtml("What your care plan covers", report.care.covers);
  const intro = `<p>You are on the <strong>${escapeHtml(report.care.packageName)}</strong> plan.</p>`;
  return covers
    ? `${intro}${covers}`
    : `<h2>What your care plan covers</h2>${intro}`;
}

/**
 * The sign-off block, printed only on the countersigned copy — the same
 * evidence, in the same order, as a proposal's acceptance block.
 */
function signOffHtml(signOff: DeliverySignOffRow): string {
  const when = signOff.signedAt.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    dateStyle: "long",
    timeStyle: "short",
  });
  const signature = signOff.signatureSvg
    ? `<div style="width:60mm;height:20mm;margin:6pt 0;">${signatureSvgMarkup(signOff.signatureSvg)}</div>`
    : "";
  return `<h2>Signed off</h2>
    ${signature}
    <table>
      <tbody>
        <tr><td>Name</td><td>${escapeHtml(signOff.signedName)}</td></tr>
        <tr><td>Email</td><td>${escapeHtml(signOff.signedEmail)}</td></tr>
        <tr><td>Signed off</td><td>${escapeHtml(when)} (UK time)</td></tr>
        ${signOff.ip ? `<tr><td>From</td><td>${escapeHtml(signOff.ip)}</td></tr>` : ""}
      </tbody>
    </table>`;
}

/** The HTML for a compiled delivery report, ready for `renderPdf`. */
export function deliveryReportDocumentHtml(report: DeliveryReport, env: NodeJS.ProcessEnv = process.env): string {
  const meta = [
    { label: "Reference", value: deliveryReportReference(report.project) },
    { label: "Prepared for", value: report.clientName },
    ...(report.project.deliveredAt ? [{ label: "Delivered", value: ukLongDate(report.project.deliveredAt) }] : []),
  ];

  const bodyHtml = [
    paragraphsHtml(report.project.summary),
    `<p><strong>${escapeHtml(report.progressSentence)}</strong></p>`,
    phasesHtml(report),
    milestonesHtml(report),
    sitesHtml(report),
    accessHtml(report, env),
    monitoringHtml(report),
    careHtml(report),
    report.signOff ? signOffHtml(report.signOff) : "",
  ].join("\n");

  return renderDocumentHtml({
    title: deliveryReportTitle(report),
    subtitle: `Handover for ${report.clientName}`,
    meta,
    bodyHtml,
    closingNote: report.signOff
      ? "This is your signed copy. Keep it — it says what was built, where it lives and what we look after from here."
      : "Read this over, then sign it off from the link in your email. Anything that looks wrong, reply and we will put it right before you sign.",
  });
}

/** The render request: the HTML, A4, and the reference in the footer. */
export function deliveryReportRenderInput(report: DeliveryReport, env: NodeJS.ProcessEnv = process.env): RenderPdfInput {
  return {
    html: deliveryReportDocumentHtml(report, env),
    format: "A4",
    margin: DOCUMENT_MARGIN,
    footerReference: deliveryReportReference(report.project),
  };
}

/**
 * The report for one project as HTML — compile and render in one call, for a
 * preview screen that wants the document without storing it.
 */
export async function deliveryReportHtml(
  db: Db,
  organisationId: string,
  input: { projectId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return deliveryReportDocumentHtml(await buildDeliveryReport(db, organisationId, input), env);
}
