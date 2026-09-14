import type { Metadata } from "next";
import { CONTACT_EMAIL, LOCATION, marketingMetadata } from "@/lib/marketing/site";
import { Container, Eyebrow } from "../../_components/primitives";

export const metadata: Metadata = marketingMetadata({
  title: "Terms",
  description: "The terms LaunchFlow works under: what is agreed per project, how payment works, who owns what, and how either side ends it.",
  path: "/terms",
});

/**
 * The terms of business.
 *
 * **A first draft that has not been read by a solicitor.** It reflects how
 * LaunchFlow actually works — the three pricing shapes, care plans on thirty
 * days' notice, scope agreed per project in writing — rather than generic
 * boilerplate, which makes it more useful and no more authoritative.
 *
 * The entity details are from Companies House, not from memory:
 * LAUNCHFLOW UK LIMITED, 17178069, incorporated 24 April 2026, registered at
 * 103a London Road, Grays RM17 5YB. A UK company has to show its registered
 * name, number and office on its website, so this page carries them whether
 * or not anybody asks.
 *
 * The company is **not VAT registered** — there is no VAT number on the
 * organisation record — so the payment section says prices carry no VAT
 * rather than implying it is added. Charging VAT while unregistered is not a
 * paperwork slip: every invoice raised that way has to be credited and
 * reissued, which is why `vat-rate.ts` refuses to do it.
 */
export default function TermsPage() {
  return (
    <Container className="py-14 sm:py-20">
      <article className="max-w-[62ch]">
        <Eyebrow line>Terms of business</Eyebrow>
        <h1 className="h-page mt-5">Terms</h1>
        <p className="lede mt-5">
          What we agree when you hire us. Written to be read rather than to be impenetrable — if anything here is unclear, ask and we will explain it
          in plain words before you sign anything.
        </p>

        <div className="mt-12 space-y-10">
          <section>
            <h2 className="h-sub">Who we are</h2>
            <p className="body mt-3 leading-relaxed">
              LaunchFlow is the trading name of <strong>LaunchFlow UK Limited</strong>, a company registered in England and Wales, company number{" "}
              <strong>17178069</strong>, registered office 103a London Road, Grays, England, RM17 5YB. In these terms &ldquo;we&rdquo; and
              &ldquo;us&rdquo; mean LaunchFlow UK Limited, and &ldquo;you&rdquo; means the business or person who engages us.
            </p>
          </section>

          <section>
            <h2 className="h-sub">The work is what the proposal says</h2>
            <p className="body mt-3 leading-relaxed">
              Before any project starts we give you a written proposal: what is included, what is not, a price and a timeline. That proposal is the
              agreement. Nothing outside it is promised, and anything you want added later is quoted separately before we build it — we would rather
              have an awkward conversation about price than quietly run over.
            </p>
            <p className="body mt-3 leading-relaxed">
              Timelines assume you come back to us. Where a project waits on your content, your feedback or access to something we need, the dates
              move by roughly the time we waited. We will tell you when that happens rather than let a deadline pass in silence.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Price and payment</h2>
            <p className="body mt-3 leading-relaxed">Projects are priced one of three ways, and your proposal says which:</p>
            <ul className="body mt-3 space-y-2 leading-relaxed">
              <li>
                <strong>Monthly from delivery.</strong> No build fee. A monthly amount that starts when the work goes live.
              </li>
              <li>
                <strong>Build fee plus monthly.</strong> Part on acceptance, the rest on launch, then a monthly care plan.
              </li>
              <li>
                <strong>One-off.</strong> A single fee for a defined piece of work, with no ongoing charge.
              </li>
            </ul>
            <p className="body mt-3 leading-relaxed">
              Invoices are due within fourteen days unless the proposal says otherwise. We are not currently VAT registered, so no VAT is added to
              our prices; if that changes we will tell you before it affects an invoice. Card payments are handled by Stripe; we never see your card
              number.
            </p>
            <p className="body mt-3 leading-relaxed">
              Third-party costs — domain registration, hosting, paid plugins, stock images, ad spend — are yours and are either billed at cost or paid
              by you directly. We will always tell you about one before committing you to it.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Care plans</h2>
            <p className="body mt-3 leading-relaxed">
              A care plan covers hosting, updates, monitoring, backups and the support hours named in your plan. It does not cover new features, new
              pages or redesigns; those are quoted as work.
            </p>
            <p className="body mt-3 leading-relaxed">
              Care plans run monthly. Either of us can end one with thirty days&rsquo; notice, and we will not hold your site hostage — if you leave we
              will hand over your files and help your next provider take it on.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Who owns what</h2>
            <p className="body mt-3 leading-relaxed">
              Once you have paid in full, the design and the code we wrote specifically for you are yours. Your content, logo and brand are yours
              throughout and always were.
            </p>
            <p className="body mt-3 leading-relaxed">
              Two things stay ours: the reusable components, tooling and platform we build every project on, which you get a licence to use as part of
              your site for as long as you like; and anything a third party licensed to us, which stays under that third party&rsquo;s terms. We may
              show finished work in our portfolio unless you ask us not to.
            </p>
          </section>

          <section>
            <h2 className="h-sub">What you provide</h2>
            <p className="body mt-3 leading-relaxed">
              You confirm you have the right to use the content, images and logos you give us. Where we write or generate content for you it is yours
              to check before it is published — we will not publish anything about your business without your approval.
            </p>
            <p className="body mt-3 leading-relaxed">
              Where we manage your social accounts, advertising or Google Business Profile on your behalf, you give us access and can remove it at any
              time. We only post what has been approved.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Your data</h2>
            <p className="body mt-3 leading-relaxed">
              For the client records we hold about you, we are the data controller and our{" "}
              <a href="/privacy" className="link-blue">
                privacy policy
              </a>{" "}
              explains it. Where we handle data belonging to <em>your</em> customers — enquiries through your site, your booking system — we are acting
              on your instructions as a processor, we use it only to run the thing you asked us to build, and we keep it on our own servers in the EU.
            </p>
            <p className="body mt-3 leading-relaxed">
              We use a small number of suppliers to deliver the work, including Hetzner for servers, Hostinger for domains, Stripe for payments and
              Postmark for email. Ask and we will tell you the current list.
            </p>
          </section>

          <section>
            <h2 className="h-sub">What we can and cannot promise</h2>
            <p className="body mt-3 leading-relaxed">
              We will do the work with reasonable skill and care, and we will fix faults in what we built. We cannot promise particular search
              rankings, particular sales, or particular results from advertising, because none of those are ours to control. Anyone who does promise
              you those is guessing.
            </p>
            <p className="body mt-3 leading-relaxed">
              Where a service we depend on fails — a host, a registrar, a payment provider, a social platform changing its rules — we will do what we
              reasonably can, but we are not liable for their outage.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Limits on liability</h2>
            <p className="body mt-3 leading-relaxed">
              We are liable for loss we cause by failing to meet these terms, but not for loss that was not foreseeable, and not for lost profit, lost
              revenue or lost data where you had a reasonable opportunity to keep your own backup. Our total liability for any project is limited to
              the amount you have paid us for it.
            </p>
            <p className="body mt-3 leading-relaxed">
              Nothing here limits liability for death or personal injury caused by negligence, for fraud, or for anything else the law does not allow
              to be limited.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Ending it</h2>
            <p className="body mt-3 leading-relaxed">
              You can stop a project at any time. You pay for the work done up to that point and we hand over what is finished. We can stop a project
              if an invoice goes more than thirty days unpaid, or if we are asked to do something unlawful, and we will say so in writing first.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Law, and changes to these terms</h2>
            <p className="body mt-3 leading-relaxed">
              These terms are governed by the law of England and Wales, and its courts have jurisdiction. We may update this page; the version that
              applies to your project is the one in force when your proposal was accepted, and we will not change your terms retrospectively.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Asking us something</h2>
            <p className="body mt-3 leading-relaxed">
              Email{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="link-blue">
                {CONTACT_EMAIL}
              </a>
              . If something has gone wrong, tell us plainly and we will try to put it right before it becomes a dispute.
            </p>
          </section>

          <p className="text-sm text-[var(--mute)]">
            LaunchFlow UK Limited, registered in England and Wales, company number 17178069. Registered office: 103a London Road, Grays, England,
            RM17 5YB. Trading from {LOCATION}.
          </p>
        </div>
      </article>
    </Container>
  );
}
