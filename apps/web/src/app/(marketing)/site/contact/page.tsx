import type { Metadata } from "next";
import { marketingLinks } from "@/lib/marketing/links";
import { CONTACT_EMAIL, CONTACT_PHONE, LOCATION, REPLY_PROMISE } from "@/lib/marketing/site";
import { Container, Eyebrow, TextLink } from "../_components/primitives";
import { ContactForm } from "./contact-form";

export const metadata: Metadata = {
  title: "Contact",
  description: `Tell LaunchFlow what you need — a web app, a mobile app, a website, ads or hosting. ${REPLY_PROMISE}`,
  alternates: { canonical: "/contact" },
  openGraph: { title: "Contact LaunchFlow", description: `Tell us what you need. ${REPLY_PROMISE}`, url: "/contact" },
};

export default async function ContactPage() {
  const { href } = await marketingLinks();

  return (
    <Container className="py-14 sm:py-20">
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <Eyebrow line>Have something in mind?</Eyebrow>
          <h1 className="h-page mt-5">Tell us what you need.</h1>
          <p className="lede mt-5">
            A couple of lines is enough. {REPLY_PROMISE} If it is a fit we will suggest a plan and a price; if it is not, we will say so and point you
            somewhere better.
          </p>

          <dl className="mt-10 space-y-6 border-t border-[var(--line)] pt-8">
            <div>
              <dt className="eyebrow">Email</dt>
              <dd className="mt-2">
                <TextLink href={`mailto:${CONTACT_EMAIL}`} external className="text-lg">
                  {CONTACT_EMAIL}
                </TextLink>
              </dd>
            </div>
            {CONTACT_PHONE ? (
              <div>
                <dt className="eyebrow">Phone</dt>
                <dd className="mt-2">
                  <a href={`tel:${CONTACT_PHONE.replace(/\s+/g, "")}`} className="tlink text-lg">
                    {CONTACT_PHONE}
                  </a>
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="eyebrow">Where</dt>
              <dd className="body mt-2">{LOCATION}. We work with businesses across Thurrock, Essex and London, and remotely anywhere in the UK.</dd>
            </div>
          </dl>

          <p className="mt-10 text-sm text-[var(--mute)]">Already a client? Raise a case in your portal and it reaches us faster than email.</p>
        </div>

        <div className="lg:col-span-7">
          <ContactForm page={href("/contact")} />
        </div>
      </div>
    </Container>
  );
}
