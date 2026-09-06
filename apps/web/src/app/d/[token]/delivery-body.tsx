import type { DeliveryReport } from "@launchos/core";

/**
 * The handover as a client reads it on a phone: what we built, where it
 * lives, where their logins are kept, what we watch, and what the care plan
 * covers.
 *
 * Deliberately **not** the PDF in an iframe, for the same reason `/p`'s
 * `ProposalBody` is not: the PDF is A4 and is what they keep, and this is the
 * same content, in the same order, laid out for a 390px screen. The order is
 * the document's order — summary, progress, what we built, milestones, where
 * it lives, your logins, what we watch, your care plan — so somebody reading
 * the page and somebody reading the file are reading the same thing.
 *
 * **No password reaches this component**, because none reaches the report:
 * `listAccessLocations` selects neither the ciphertext, the username nor the
 * notes field. What is printed is the name of each way in, its address, and
 * whether we hold a key to it.
 */

const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" };

function ukDate(value: Date | null): string | null {
  return value ? value.toLocaleDateString("en-GB", DAY) : null;
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => (
          <p key={block.slice(0, 40)} className="body mt-3 whitespace-pre-line">
            {block}
          </p>
        ))}
    </>
  );
}

/** A label/value row of the kind every section on this page is made of. */
function Row({ title, note, right }: { title: string; note?: string | null; right: string }) {
  return (
    <li className="flex flex-wrap justify-between gap-3 border-b py-3 text-base" style={{ borderColor: "var(--line)" }}>
      <span className="min-w-0">
        {title}
        {note ? (
          <span className="block text-sm break-words" style={{ color: "var(--mute)" }}>
            {note}
          </span>
        ) : null}
      </span>
      {/* `ml-auto` as well as `justify-between`, the same fix the proposal
          schedule needed: a long name wraps the right-hand value onto its own
          line, and a value that then sits left of the one above it reads as a
          different column. */}
      <span className="ml-auto shrink-0 text-sm" style={{ color: "var(--mute)" }}>
        {right}
      </span>
    </li>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="h-sub">{heading}</h2>
      {children}
    </section>
  );
}

export function DeliveryBody({ report, portalUrl }: { report: DeliveryReport; portalUrl: string }) {
  const { project, phases, milestones, sites, access, monitors, care, progressSentence } = report;
  // `skipped` is left out here exactly as it is left out of the PDF: a step
  // that was never needed is not a step the client was promised.
  const built = phases.filter((phase) => phase.status !== "skipped");

  return (
    <div className="grid gap-10">
      {project.summary ? (
        <section>
          <h2 className="h-sub">In short</h2>
          <Paragraphs text={project.summary} />
        </section>
      ) : null}

      <p className="text-base font-semibold">{progressSentence}</p>

      {built.length > 0 ? (
        <Section heading="What we built">
          <ul className="mt-4">
            {built.map((phase) => (
              <Row
                key={phase.name}
                title={phase.name}
                right={ukDate(phase.doneAt) ?? (phase.status === "done" ? "Done" : "In progress")}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {milestones.length > 0 ? (
        <Section heading="Milestones">
          <ul className="mt-4">
            {milestones.map((milestone) => (
              <Row
                key={milestone.title}
                title={milestone.title}
                note={milestone.detail}
                right={ukDate(milestone.reachedAt) ?? "Still to come"}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {sites.length > 0 ? (
        <Section heading="Where it lives">
          <ul className="mt-4">
            {sites.map((site) => (
              <Row key={site.url} title={site.name} note={site.url} right={site.live ? "Live" : "Not live yet"} />
            ))}
          </ul>
        </Section>
      ) : null}

      {access.length > 0 ? (
        <Section heading="Your logins">
          <p className="body mt-3">
            These are the accounts and machines your website runs on. <strong>No password is printed here</strong> — they
            are held encrypted in LaunchFlow, and every time one of us looks at one it is recorded with our name and the
            date. Ask through your portal at{" "}
            <a href={portalUrl} className="tlink break-all">
              {portalUrl}
            </a>{" "}
            and we will hand any of them over.
          </p>
          <ul className="mt-4">
            {access.map((entry) => (
              <Row
                key={`${entry.kind}-${entry.label}-${entry.url ?? entry.host ?? ""}`}
                title={`${entry.kindLabel} — ${entry.label}${entry.siteName ? ` (${entry.siteName})` : ""}`}
                note={entry.url ?? entry.host}
                right={entry.hasSecret ? "We hold the password" : "No password held"}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {monitors.length > 0 ? (
        <Section heading="What we watch">
          <p className="body mt-3">
            If any of these stops answering we are told automatically, and we start looking before you have to tell us.
          </p>
          <ul className="mt-4">
            {monitors.map((monitor) => {
              const minutes = Math.max(1, Math.round(monitor.intervalSeconds / 60));
              return (
                <Row
                  key={monitor.target}
                  title={monitor.siteName}
                  note={monitor.target}
                  right={minutes === 1 ? "Every minute" : `Every ${minutes} minutes`}
                />
              );
            })}
          </ul>
        </Section>
      ) : null}

      {care ? (
        <Section heading="What your care plan covers">
          <p className="body mt-3">
            You are on the <strong>{care.packageName}</strong> plan.
          </p>
          {care.covers.length > 0 ? (
            <ul className="mt-4 grid gap-2">
              {care.covers.map((item) => (
                <li key={item} className="flex gap-3 text-base">
                  <span aria-hidden style={{ color: "var(--blue)" }}>
                    ✓
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
