import type { Metadata } from "next";
import { CONTACT_EMAIL, LOCATION } from "@/lib/marketing/site";
import { Container, Eyebrow } from "../_components/primitives";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What LaunchFlow collects from this website and what happens to it. Short, because there is not much.",
  alternates: { canonical: "/privacy" },
  openGraph: { title: "Privacy — LaunchFlow", url: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <Container className="py-14 sm:py-20">
      <article className="max-w-[62ch]">
        <Eyebrow line>Privacy policy</Eyebrow>
        <h1 className="h-page mt-5">Privacy</h1>
        <p className="lede mt-5">This is a short page because we collect very little. Here is all of it.</p>

        <div className="mt-12 space-y-10">
          <section>
            <h2 className="h-sub">What we collect on this site</h2>
            <p className="body mt-3 leading-relaxed">
              The contact form: your name, email address, and whatever you type in the message, plus your phone number and business name if you give
              them. We also keep the IP address the message came from, so we can stop a script filling the form. That is stored in our own system, on
              our own server in the EU, and used to reply to you. Nothing else on this site records who you are.
            </p>
          </section>

          <section>
            <h2 className="h-sub">No ad tracking</h2>
            <p className="body mt-3 leading-relaxed">
              There is no Google Analytics, no Meta pixel and no third-party cookie on this site. We do not sell or share your details with anyone, and
              there is no mailing list to fall into.
            </p>
          </section>

          <section>
            <h2 className="h-sub">If you become a client</h2>
            <p className="body mt-3 leading-relaxed">
              Your account, support cases, invoices and reports live in our portal at os.launchflow.co.uk. Card payments are taken by Stripe, which
              handles your card details under its own privacy policy; we never see the number. We keep your records for as long as you are a client and
              for the period UK tax rules require after that.
            </p>
          </section>

          <section>
            <h2 className="h-sub">Your rights</h2>
            <p className="body mt-3 leading-relaxed">
              Ask and we will tell you what we hold about you, correct it, or delete it where the law lets us. Email{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="link-blue">
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </section>

          <p className="text-sm text-[var(--mute)]">LaunchFlow is run from {LOCATION}, United Kingdom, and is the data controller for the details above.</p>
        </div>
      </article>
    </Container>
  );
}
