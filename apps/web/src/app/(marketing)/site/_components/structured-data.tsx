import { OG_IMAGE, SITE_DESCRIPTION, SITE_NAME } from "@/lib/marketing/site";

/**
 * What LaunchFlow is, in the form a search engine reads.
 *
 * Google infers a great deal from a page and gets a lot of it right, but the
 * things it cannot infer are the ones that matter for a local business: that
 * this is one organisation rather than several, where it is, and which
 * scattered profiles are the same company. That is what `sameAs` and a single
 * `@id` settle.
 *
 * `ProfessionalService` rather than `LocalBusiness`: the work is done for
 * businesses anywhere in the UK from a base in Grays, not walk-in trade, and
 * claiming an address people might turn up at would be describing the wrong
 * thing. `areaServed` says United Kingdom for the same reason.
 *
 * Everything below is on the page it describes. Schema for content that is not
 * there is the fastest way to earn a manual action, and there is no version of
 * a rich result worth that.
 */
export function OrganisationSchema({ base }: { base: string }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "ProfessionalService",
    "@id": `${base}/#organisation`,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: base,
    logo: `${base}/brand/launchflow-logo.png`,
    image: `${base}${OG_IMAGE.url}`,
    email: "hello@launchflow.co.uk",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Grays",
      addressRegion: "Essex",
      addressCountry: "GB",
    },
    areaServed: { "@type": "Country", name: "United Kingdom" },
    knowsAbout: [
      "Web application development",
      "Mobile app development",
      "Website design and hosting",
      "Search engine optimisation",
      "Google Ads and Meta Ads management",
      "Business automation",
    ],
  };

  return (
    <script
      type="application/ld+json"
      // The object is built here from constants, never from user input, so
      // there is nothing in it a page could inject.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

/**
 * The site's own pages, so a search result can show the path a visitor would
 * have taken rather than a bare URL.
 */
export function BreadcrumbSchema({ base, trail }: { base: string; trail: readonly { name: string; path: string }[] }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: `${base}${crumb.path === "/" ? "" : crumb.path}`,
    })),
  };

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />;
}
