import type { Metadata } from "next";
import { Mail, MapPin, Phone } from "lucide-react";
import { marketingLinks } from "@/lib/marketing/links";
import { CONTACT_EMAIL, CONTACT_PHONE, LOCATION, REPLY_PROMISE } from "@/lib/marketing/site";
import { Container } from "../_components/primitives";
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
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <h1 className="display text-4xl sm:text-5xl">Tell us what you need.</h1>
          <p className="lede mt-5 text-lg text-muted-foreground">
            A couple of lines is enough. {REPLY_PROMISE} If it is a fit we will suggest a plan and a price; if it is not, we will say
            so and point you somewhere better.
          </p>

          <dl className="mt-10 space-y-5 text-base">
            <div className="flex gap-3">
              <dt className="sr-only">Email</dt>
              <Mail aria-hidden className="mt-1 size-5 shrink-0 text-primary" />
              <dd>
                <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium hover:underline">
                  {CONTACT_EMAIL}
                </a>
              </dd>
            </div>
            {CONTACT_PHONE ? (
              <div className="flex gap-3">
                <dt className="sr-only">Phone</dt>
                <Phone aria-hidden className="mt-1 size-5 shrink-0 text-primary" />
                <dd>
                  <a href={`tel:${CONTACT_PHONE.replace(/\s+/g, "")}`} className="font-medium hover:underline">
                    {CONTACT_PHONE}
                  </a>
                </dd>
              </div>
            ) : null}
            <div className="flex gap-3">
              <dt className="sr-only">Where</dt>
              <MapPin aria-hidden className="mt-1 size-5 shrink-0 text-primary" />
              <dd>
                {LOCATION}. We work with businesses across Thurrock, Essex and London, and remotely anywhere in the UK.
              </dd>
            </div>
          </dl>

          <p className="mt-10 text-sm text-muted-foreground">
            Already a client? Raise a case in your portal and it reaches us faster than email.
          </p>
        </div>

        <ContactForm page={href("/contact")} />
      </div>
    </Container>
  );
}
