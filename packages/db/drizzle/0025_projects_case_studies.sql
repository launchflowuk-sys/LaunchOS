CREATE TYPE "public"."project_phase_key" AS ENUM('brief', 'design', 'build', 'review', 'launch', 'care');--> statement-breakpoint
CREATE TYPE "public"."project_phase_status" AS ENUM('pending', 'active', 'done', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('planned', 'active', 'on_hold', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."case_study_delivery_status" AS ENUM('live', 'in-build', 'in-testing', 'discovery');--> statement-breakpoint
CREATE TYPE "public"."case_study_kind" AS ENUM('client', 'product');--> statement-breakpoint
CREATE TYPE "public"."case_study_status" AS ENUM('draft', 'review', 'published', 'unlisted');--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"phase_id" uuid,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"target_date" date,
	"reached_at" timestamp with time zone,
	"sort" integer DEFAULT 0 NOT NULL,
	"client_visible" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"key" "project_phase_key" NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"status" "project_phase_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"proposal_id" uuid,
	"name" text NOT NULL,
	"summary" text,
	"status" "project_status" DEFAULT 'planned' NOT NULL,
	"started_at" timestamp with time zone,
	"target_date" date,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "case_studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"client_name" text,
	"sector" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"brief" jsonb DEFAULT '{"client":"","problem":"","built":"","results":""}'::jsonb NOT NULL,
	"stack" text[] DEFAULT '{}' NOT NULL,
	"year" integer,
	"url" text,
	"screenshots" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"kind" "case_study_kind" DEFAULT 'client' NOT NULL,
	"status" "case_study_status" DEFAULT 'draft' NOT NULL,
	"delivery_status" "case_study_delivery_status" DEFAULT 'live' NOT NULL,
	"charity" boolean DEFAULT false NOT NULL,
	"powered_by" jsonb,
	"domain" text,
	"tagline" text,
	"description" text,
	"facts" text[] DEFAULT '{}' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "phase_id" uuid;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_milestones_project_sort" ON "project_milestones" USING btree ("project_id","sort");--> statement-breakpoint
CREATE INDEX "project_milestones_org_client" ON "project_milestones" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE INDEX "project_milestones_project_reached" ON "project_milestones" USING btree ("project_id","reached_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_phases_project_key" ON "project_phases" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "project_phases_project_sort" ON "project_phases" USING btree ("project_id","sort");--> statement-breakpoint
CREATE INDEX "project_phases_org_client" ON "project_phases" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_proposal" ON "projects" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "projects_org_status_created" ON "projects" USING btree ("organisation_id","status","created_at");--> statement-breakpoint
CREATE INDEX "projects_org_client" ON "projects" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_studies_org_slug" ON "case_studies" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "case_studies_project" ON "case_studies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "case_studies_org_status_sort" ON "case_studies" USING btree ("organisation_id","status","sort");--> statement-breakpoint
CREATE INDEX "case_studies_org_client" ON "case_studies" USING btree ("organisation_id","client_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_project_phase" ON "tasks" USING btree ("project_id","phase_id");
--> statement-breakpoint
-- The portfolio as it stood on 6 September 2026, seeded so that deleting
-- `apps/web/src/lib/marketing/work.ts` and `products.ts` does not blank the
-- Work and Products pages. Generated from `PORTFOLIO` in
-- `packages/core/src/case-studies/portfolio.ts`, which stays the source of the
-- copy; `seedCaseStudies()` runs the same insert for an organisation created
-- after this migration. Idempotent: every statement is scoped to organisations
-- that do not already have the slug, so re-running changes nothing and a story
-- Shoji has since rewritten is never reverted.
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'grays-cabline', 'Grays CabLine', 'Grays CabLine', 'Taxi and airport transfers', 'Online booking with instant fares, card payment and a dispatch office behind it, for a Thurrock taxi firm.', '{"client":"Grays CabLine is a licensed taxi and airport-transfer firm in Grays, Essex — and it is Shoji''s own company, run as an owner-driver for nine years. It was the first business LaunchFlow ever built for.","problem":"The old WordPress site took bookings by phone and a slow third-party dispatch plugin. Customers wanted a price before they rang, drivers wanted jobs on their phones, and the office wanted to stop retyping everything.","built":"A thirty-page site with a four-step booking engine: address lookup, a pricing engine that quotes by distance, vehicle choice, then card, cash or pay-later. Airport pages for Heathrow, Gatwick, Stansted, Luton and Southend. Behind it, a PIN-protected dispatch office for bookings, drivers, pricing and reports, a customer tracking page for every job, and conversion events wired into Google Ads.","results":"Ranks on the first page for its local searches, and enquiries and bookings both rose after the move. The dispatch side grew into Cabio, our multi-tenant platform, which the firm now runs on."}'::jsonb, array['React', 'Express', 'PostgreSQL', 'Square payments', 'Google Maps', 'Expo', 'Coolify']::text[], 2026, 'https://grayscabline.co.uk', '{"desktop":"/work/grays-cabline-desktop.jpg","mobile":"/work/grays-cabline-mobile.jpg"}'::jsonb, true, 'client', 'published', 'live', false, '{"name":"Cabio","url":"https://cabio.cab","logo":"/brand/cabio-logo.png","logoWidth":600,"logoHeight":156}'::jsonb, null, null, null, '{}'::text[], 0, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'lakeside-purfleet-taxis', 'Lakeside & Purfleet Taxis', 'Lakeside & Purfleet Taxis Ltd', 'Taxi', 'A lead-generation site with a five-step quote form and an admin panel for following every enquiry up.', '{"client":"Lakeside & Purfleet Taxis is a taxi operator covering Lakeside, Purfleet and the rest of Thurrock.","problem":"They wanted enquiries captured online, around the clock, without taking on a live booking and payment system they were not ready to run.","built":"Thirty-odd pages — services, six airport pages, nine area pages — fronted by a five-step quote form that writes straight into a leads database. Staff sign in to filter leads, set a status, add notes, record the quoted price and the driver, and email the customer back from the same screen. A stats dashboard shows the week at a glance.","results":"Live on our servers with nightly backups. Enquiry capture with manual follow-up, exactly as briefed, with online payment ready to switch on later."}'::jsonb, array['React', 'Express', 'PostgreSQL', 'Docker', 'Coolify']::text[], 2026, 'https://lakesidetaxi.co.uk', '{"desktop":"/work/lakeside-purfleet-taxis-desktop.jpg","mobile":"/work/lakeside-purfleet-taxis-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, '{"name":"Cabio","url":"https://cabio.cab","logo":"/brand/cabio-logo.png","logoWidth":600,"logoHeight":156}'::jsonb, null, null, null, '{}'::text[], 1, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'ockendon-station-taxis', 'Ockendon Station Taxis', 'Ockendon Station Taxis', 'Taxi', 'A local taxi site built round station pickups and fixed airport fares, with a step-by-step booking enquiry.', '{"client":"Ockendon Station Taxis is a private hire firm working South Ockendon, Aveley, Grays, Chafford Hundred and the rest of Thurrock.","problem":"Almost all their work starts with somebody standing at Ockendon Station or planning an early airport run, and almost all of it came in by phone. There was nothing online for the passenger who wants a price before they ring, and nothing at all after hours.","built":"A site organised the way the work actually arrives: local journeys, station pickups and airport transfers, each with its own page and its own area pages for the villages around Ockendon. A multi-step booking enquiry asks for the journey type first, then the addresses, dates and passenger count, so a return airport run with a flight number takes the same short form as a trip to the shops. Airport fares are published — Heathrow, Gatwick, Stansted, Luton and London City — so the price question is answered before anybody picks up the phone.","results":"Enquiries now arrive around the clock with the journey already described, and the published airport fares do the quoting."}'::jsonb, array['WordPress', 'Fluent Forms', 'Cabio', 'Google Business Profile']::text[], 2026, 'https://ockendonstationtaxis.co.uk', '{"desktop":"/work/ockendon-station-taxis-desktop.jpg","mobile":"/work/ockendon-station-taxis-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, '{"name":"Cabio","url":"https://cabio.cab","logo":"/brand/cabio-logo.png","logoWidth":600,"logoHeight":156}'::jsonb, null, null, null, '{}'::text[], 2, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'grays-town-taxis', 'Grays Town Taxis', 'Grays Town Taxis', 'Taxi and airport transfers', 'A fixed-price booking site on Cabio, with live tracking, corporate accounts and the Google Ads that feed it.', '{"client":"Grays Town Taxis is Safiullah Mansoor''s private hire firm in Grays, running local work, school runs and airport transfers around the clock.","problem":"A one-driver-up operator competing with the big Thurrock firms needs to look every bit as solid as they do — instant quotes, fixed airport prices, tracking, card payment — without paying for a dispatch platform priced for a fleet.","built":"The site runs on Cabio Solo, our subscription tier for the single operator: the booking engine, the quote, the live tracking link and the card payment are the same ones our fleet customers use, embedded straight into the site. On top of that a marketing site with fixed airport fares to seven airports, service pages for local, corporate, school-run, long-distance and wedding work, an application form for corporate and school accounts with monthly invoicing, and real Google reviews on the page. We run the Google Ads alongside it.","results":"Online booking and tracking on a solo operator''s budget, with quotes arriving overnight instead of waiting for the phone."}'::jsonb, array['Cabio', 'Google Ads', 'Google Business Profile', 'Coolify']::text[], 2026, 'https://graystowntaxis.co.uk', '{"desktop":"/work/grays-town-taxis-desktop.jpg","mobile":"/work/grays-town-taxis-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, '{"name":"Cabio","url":"https://cabio.cab","logo":"/brand/cabio-logo.png","logoWidth":600,"logoHeight":156}'::jsonb, null, null, null, '{}'::text[], 3, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'star-grooming', 'Star Grooming', 'Star Grooming', 'Cat grooming', 'A marketing site and booking form with a back office that reads the inbox, runs live chat and tracks every lead.', '{"client":"Star Grooming is a cat-only groomer in Essex, run by Jade.","problem":"Enquiries arrived by email, Facebook, text and phone, and some were lost. Jade needed a professional site and one place to see every lead and answer it.","built":"A premium site with service, breed and location pages for search, a gallery and reviews, plus an online booking form with photo attachments. The admin dashboard has a lead pipeline (new, contacted, offered, booked), customer records, an inbox that reads and replies to the business email in-app, live chat with an AI assistant that hands over to Jade the moment she replies, and email and SMS alerts.","results":"Every enquiry lands in one pipeline with a status, and the AI chat answers the questions Jade used to answer twenty times a day."}'::jsonb, array['React', 'Express', 'PostgreSQL', 'OpenAI', 'Twilio', 'Coolify']::text[], 2026, 'https://starcatgrooming.com', '{"desktop":"/work/star-grooming-desktop.jpg","mobile":"/work/star-grooming-mobile.jpg"}'::jsonb, true, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 4, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'be-gorgeous-by-monika', 'Be Gorgeous by Monika', 'Be Gorgeous by Monika', 'Beauty salon', 'A salon booking system with a diary, client records, payments and branded confirmation emails.', '{"client":"Be Gorgeous by Monika is a beauty and aesthetics salon in Grays, Essex.","problem":"Bookings lived in messages and a paper diary. Double bookings happened, reminders were manual, and there was no record of who had what done.","built":"A public booking site and a back office: the diary, client records, services, staff, opening hours, payments and notifications. Bookings create and update client records automatically; the bookings table filters, sorts, totals and exports to CSV. Every confirmation and reminder email was rebuilt and can be previewed in one command. The system was then generalised so it can carry more than one salon.","results":"Live for the salon, with the diary running the day. Now the base of our salon product."}'::jsonb, array['React', 'Express', 'PostgreSQL', 'Caddy', 'Coolify']::text[], 2026, 'https://begorgeousbymonika.com', '{"desktop":"/work/be-gorgeous-by-monika-desktop.jpg","mobile":"/work/be-gorgeous-by-monika-mobile.jpg"}'::jsonb, true, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 5, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'thurrock-tuition-academy', 'Thurrock Tuition Academy', 'Thurrock Tuition Academy', 'Private tuition', 'A landing page, an admin dashboard and a parent portal for a Grays tutoring business.', '{"client":"Thurrock Tuition Academy is Khadija''s private tutoring business in Grays.","problem":"She needed more than a brochure: somewhere to take enquiries, keep track of students and sessions, and let parents see progress and payments.","built":"Three surfaces on one app. A public page with subjects, levels, pricing and a WhatsApp booking button. An admin dashboard for enquiries, students, sessions, progress, tasks and payments. A parent portal, gated by sign-in, where each family sees only their own children. Auth is our own, with roles assigned at sign-up.","results":"Live at thurrocktuitionacademy.co.uk, and the first site moved from Replit onto our own servers — the lowest-risk one, so the pipeline was proven before the bigger sites followed."}'::jsonb, array['React', 'Express', 'PostgreSQL', 'Tailwind', 'Docker']::text[], 2026, 'https://thurrocktuitionacademy.co.uk', '{"desktop":"/work/thurrock-tuition-academy-desktop.jpg","mobile":"/work/thurrock-tuition-academy-mobile.jpg"}'::jsonb, false, 'client', 'published', 'in-build', false, null, null, null, null, '{}'::text[], 6, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'grays-park-masjid', 'Grays Park Masjid', 'Grays Park Masjid', 'Community and charity', 'A public website, an admin system and a companion app for the local masjid — built free, as charity.', '{"client":"Grays Park Masjid is the mosque and community organisation in Grays. It is where Shoji prays, and the work was done for nothing.","problem":"Membership, donations and announcements were handled offline. Applicants had no way to check where their membership stood, and prayer times had to be looked up elsewhere.","built":"A public site with prayer times, announcements, events, a gallery, a membership form with a status lookup that needs no account, and one-off or recurring donations through Square. An admin dashboard runs the membership approval workflow, all content, staff and volunteers, donation records and notifications. A companion app with prayer times, Qibla, donations and reading is prepared for the stores.","results":"Everything the masjid publishes now goes through one dashboard, and donations are taken online. The app is in store submission."}'::jsonb, array['React', 'Express', 'PostgreSQL', 'Square', 'Expo', 'Coolify']::text[], 2026, 'https://graysparkmasjid.org.uk', '{"desktop":"/work/grays-park-masjid-desktop.jpg","mobile":"/work/grays-park-masjid-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', true, null, null, null, null, '{}'::text[], 7, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'nexus-education-group', 'Nexus Education Group', 'Nexus Education Group', 'Education consultancy', 'A study-abroad platform: course directory, applications, document vault, an AI assistant and a staff dashboard.', '{"client":"Nexus Education Group helps students from Islamabad, Rawalpindi and Chakwal apply to universities in the UK, USA, Canada, Australia and Europe.","problem":"Student intake ran on WhatsApp and spreadsheets. Documents went missing, enquiries arrived at every hour, and nobody could see the pipeline.","built":"A course and university directory, application and consultation flows, a document vault for student uploads, and an AI assistant that answers questions and hands over leads. Staff sign in to a dashboard with owner, admin and staff roles and a full audit log. Branded notifications go out for every enquiry, application and upload. A student app talks to the same API.","results":"Live and the most actively developed client platform we run, with the marketing site and the student app being merged into one system."}'::jsonb, array['React', 'Express', 'PostgreSQL', 'Claude API', 'Google Places', 'Coolify']::text[], 2026, 'https://nexusedu.co.uk', '{"desktop":"/work/nexus-education-group-desktop.jpg","mobile":"/work/nexus-education-group-mobile.jpg"}'::jsonb, true, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 8, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'mobile-pc-doctor', 'Mobile PC Doctor', 'Mobile PC Doctor', 'Computer repair', 'A repair-shop system where every job and every message has a running clock, on the web and in an app.', '{"client":"Mobile PC Doctor is a computer repair business in Grays — another of our own.","problem":"Jobs were lost to unanswered messages, and repairs ran quietly late because nobody was watching a promised date.","built":"A booking, job-tracking, messaging and payments system built round one idea: a clock on everything. A response clock runs while a customer waits to hear back; a delivery clock runs from the moment a quote promises a date. Anything overdue appears on a staff Today screen and buzzes the phone. Enquiries arrive from a web form, from SMS and from the app into one inbox, and a customer who enquired on the web finds the conversation waiting when they install the app.","results":"The website and booking are live at mpcdoctor.com. The app is in TestFlight with the shop: customer and staff share one app, role-switched, alongside an owner dashboard."}'::jsonb, array['Expo', 'Express', 'PostgreSQL', 'Twilio', 'React']::text[], 2026, 'https://mpcdoctor.com', '{"desktop":"/work/mobile-pc-doctor-desktop.jpg","mobile":"/work/mobile-pc-doctor-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 9, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'kd-essex', 'KD Essex Landscaping', 'KD Essex Landscaping & Groundworks', 'Landscaping and groundworks', 'Research first, then a site on our BizzFlow platform that positions the firm where nobody else is.', '{"client":"KD Essex is a landscaping, driveway and groundworks contractor in Thurrock and South Essex.","problem":"Every paving firm in Grays fights for the same map pack on proximity alone. KD needed a website, but first it needed a reason to be chosen.","built":"Before a line of the site, a research deck: competitors, reviews and searches across Thurrock and South Essex. The finding was that groundworks in the region is commercially unclaimed — the landscapers cannot dig and the groundworkers cannot finish. The plan positions KD as the one contractor who does the foundations, drainage and levels and then finishes the garden or driveway on top. The site itself runs on BizzFlow, our white-label platform for the trades: public site, enquiry capture and a CRM behind it, live in days rather than weeks.","results":"Research and build plan delivered as a client deck; site live on BizzFlow."}'::jsonb, array['Research', 'BizzFlow', 'Google Ads']::text[], 2026, 'https://bizzflowuk.com/site/kd-essex', '{"desktop":"/work/kd-essex-desktop.jpg","mobile":"/work/kd-essex-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 10, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'farm-pizza', 'Farm Pizza', 'Farm Pizza', 'Takeaway', 'Direct online ordering for a pizza takeaway — the first shop on our takeaway platform.', '{"client":"Farm Pizza is a pizza takeaway trading in Basildon and Grays.","problem":"Orders came through aggregator apps that took a cut of every sale and kept the customer.","built":"A storefront with the full menu, Apple Pay and Google Pay, a kitchen pass screen and a back office. The back office does marketing as well as orders: automations that win back lapsed customers, nudge one-timers and fill quiet nights, one-off campaigns to nine customer segments, and abandoned-basket recovery. Search is built in with server-rendered menus, structured data and a page per locality. The whole thing is config-driven, so the next takeaway is a folder and a deploy.","results":"Live and in final testing with the shop before card payments switch on. A customer app is specified next."}'::jsonb, array['Next.js', 'PostgreSQL', 'Stripe', 'Resend', 'Twilio', 'Coolify']::text[], 2026, 'https://farm-pizza.shop', '{"desktop":"/work/farm-pizza-desktop.jpg","mobile":"/work/farm-pizza-mobile.jpg"}'::jsonb, false, 'client', 'published', 'in-testing', false, null, null, null, null, '{}'::text[], 11, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'amo-rendering', 'AMO Rendering', 'AMO Rendering', 'Rendering and construction', 'A full trade website, CRM and customer portal on BizzFlow, plus Google Ads that bring the work in.', '{"client":"AMO Rendering is an external-wall rendering firm in Grays, with a sister construction business, AMO Services. Both are run by Mark from one login.","problem":"A rendering firm needs a site that sells five kinds of render to homeowners who do not know the difference, a way to quote fast, and adverts that do not waste money.","built":"AMO was the first tenant on BizzFlow, our white-label platform for the trades. The site has service pages, area pages, a gallery, reviews, case studies, a render colour visualiser and a cost calculator, with quote forms feeding a CRM pipeline. Homeowners track their job in a customer portal. We also run the Google Ads: keyword, ad and negative lists rebuilt from scratch, with a monthly report.","results":"Two businesses live on one platform. Google Business Profile, site and ads now agree on the same address and the same story."}'::jsonb, array['BizzFlow', 'React', 'Express', 'PostgreSQL', 'Google Ads', 'Coolify']::text[], 2026, 'https://amorendering.co.uk', '{"desktop":"/work/amo-rendering-desktop.jpg","mobile":"/work/amo-rendering-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 12, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'amo-services', 'AMO Services', 'AMO Services', 'Construction and building', 'A construction company''s site with a service page per trade and a quote form that feeds the same CRM as its sister firm.', '{"client":"AMO Services is a construction company in Grays, established in 2011 and covering Essex and London — new builds, commercial works, home renovations, loft conversions, kitchens, electrical work and bricklaying. It is Mark Baker''s second business, alongside AMO Rendering.","problem":"One firm doing seven quite different trades is hard to sell in a single paragraph. A homeowner searching for a loft conversion and a developer looking for groundworks want completely different pages, and neither wanted to read about the other. Both businesses also had to be run from one login rather than two systems.","built":"A page per trade — new builds, commercial, renovations, lofts, electrical, kitchens, bricklaying — each one landing its own searches and each one ending at the same free-quote form. The story that ties them together is the one AMO actually sells on: one team from first visit to final handover, building and electrical under one roof, a written quotation before anything starts. Enquiries land in the same BizzFlow CRM as AMO Rendering, so Mark runs both businesses from a single login.","results":"Two businesses, one back office. The seven trades each have somewhere to rank instead of sharing one crowded page."}'::jsonb, array['BizzFlow', 'React', 'Express', 'PostgreSQL', 'Coolify']::text[], 2026, 'https://amoservices.co.uk', '{"desktop":"/work/amo-services-desktop.jpg","mobile":"/work/amo-services-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 13, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'lifestyle-windows', 'LifeStyle Windows', 'Chathwell Windows Ltd', 'Windows, doors and conservatories', 'A premium glazing site with an instant estimate tool, a product page for every style and an area page for every town.', '{"client":"LifeStyle Windows, trading as Chathwell Windows Ltd, is a family-run, FENSA-registered glazing installer working across Dagenham, East London and Essex. They have fitted windows, doors and conservatories since 2010 with their own installers rather than subcontractors.","problem":"Glazing is a trade with a reputation problem, and the firms that deserve better are the ones least able to show it. Homeowners compare on price alone because nothing on a typical glazing site tells them what they are getting, and every enquiry turns into a survey visit before anyone knows whether the budget is close.","built":"A site built to answer the question before the phone call. An instant estimate tool gives a homeowner a number without a salesperson in the room. Every product has its own page — double and triple glazing, uPVC, aluminium, sash, bay and casement windows; composite, uPVC, aluminium, bifold, patio and French doors; conservatories — so a search for one style lands on that style. Service-area pages cover Dagenham, Romford, Ilford, Barking, Redbridge, East London and Essex. The trust marks that matter in this trade sit where they are read: FENSA registration, PAS 24 and Secured by Design, the 15-year guarantee, in-house fitters and a gallery of real installs.","results":"Our Premium Plan client: the site, the estimate tool, the search work and the ongoing care run together, and the enquiries arrive with a budget already attached."}'::jsonb, array['WordPress', 'Divi', 'Custom estimate plugin', 'Google Business Profile']::text[], 2026, 'https://lifestylewindow.co.uk', '{"desktop":"/work/lifestyle-windows-desktop.jpg","mobile":"/work/lifestyle-windows-mobile.jpg"}'::jsonb, false, 'client', 'published', 'live', false, null, null, null, null, '{}'::text[], 14, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'cabio', 'Cabio Master Booker', null, 'Transport', 'The dispatch platform our own taxi firm runs on, sold to other UK operators as a subscription.', '{"client":"","problem":"","built":"","results":""}'::jsonb, '{}'::text[], null, 'https://cabio.cab', '{"desktop":"/work/cabio-desktop.jpg","mobile":"/work/cabio-mobile.jpg"}'::jsonb, true, 'product', 'published', 'live', false, null, 'cabio.cab', 'Multi-tenant taxi dispatch for UK operators.', 'The dispatch platform our own taxi firm runs on, sold to other operators as a subscription. Each operator gets their own branded booking site and subdomain, a dispatch office, drivers on the app, and pricing by distance, time or fixed fare with night and zone surcharges. Built to compete with the incumbents on price and on speed.', array['iOS and Android apps live', 'Embeddable booking widget', 'Card payments and subscription billing', 'Runs Grays CabLine and Grays Taxis 247']::text[], 15, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'agent-zero', 'Agent Zero', null, 'Voice AI', 'Answers a business’s calls, quotes a price and writes the booking into the back office.', '{"client":"","problem":"","built":"","results":""}'::jsonb, '{}'::text[], null, 'https://cabioagentzero.com', '{"desktop":"/work/agent-zero-desktop.jpg","mobile":"/work/agent-zero-mobile.jpg"}'::jsonb, true, 'product', 'published', 'live', false, null, 'cabioagentzero.com', 'An AI phone agent that answers and books.', 'Answers a business''s inbound calls, holds a natural conversation, quotes a price and writes the booking into the back office. Calls arrive over Twilio and are routed to the right business by the number dialled, so many businesses share one platform. Operators choose whether the agent answers first or their phone rings first, by schedule.', array['Claude for the conversation', 'Twilio, Deepgram and ElevenLabs', 'Pushes bookings into Cabio and other dispatch systems', 'Operator app on both stores']::text[], 16, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'bizzflow', 'BizzFlow', null, 'For the trades', 'A complete website, CRM and customer portal for a trade firm, under its own brand.', '{"client":"","problem":"","built":"","results":""}'::jsonb, '{}'::text[], null, 'https://bizzflowuk.com', '{"desktop":"/work/bizzflow-desktop.jpg","mobile":"/work/bizzflow-mobile.jpg"}'::jsonb, true, 'product', 'published', 'live', false, null, 'bizzflowuk.com', 'White-label websites and CRM for the trades.', 'One platform that gives a rendering, roofing or landscaping firm a complete website under their own brand, a CRM for leads, quotes and projects, and a portal where homeowners follow their job. One deployment serves every tenant, and one owner can run several businesses from a single login.', array['Website, CRM and customer portal', 'Render visualiser and cost calculator', 'AMO Rendering and AMO Services live', 'Google Ads run alongside']::text[], 17, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'launchos', 'LaunchOS', null, 'Client experience', 'The portal every LaunchFlow client gets: support, plan, content, reports and invoices.', '{"client":"","problem":"","built":"","results":""}'::jsonb, '{}'::text[], null, 'https://os.launchflow.co.uk/sign-in', '{"desktop":"/work/launchos-desktop.jpg","mobile":"/work/launchos-mobile.jpg"}'::jsonb, true, 'product', 'published', 'live', false, null, 'os.launchflow.co.uk', 'The portal every LaunchFlow client gets.', 'The system this agency runs on, and the website you are reading. Clients sign in to raise support cases, see the plan they are on, approve the month''s content, read reports and pay invoices. Behind it, AI agents watch uptime, triage support and write content — and nothing reaches a client without a human approving it.', array['Support, plan, content and invoices in one place', 'Uptime monitoring and incidents', 'Ad reports every month', 'Every agent action approved by a person']::text[], 18, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "case_studies" ("organisation_id", "slug", "name", "client_name", "sector", "summary", "brief", "stack", "year", "url", "screenshots", "featured", "kind", "status", "delivery_status", "charity", "powered_by", "domain", "tagline", "description", "facts", "sort", "published_at")
SELECT o."id", 'takeaway-platform', 'Takeaway ordering platform', null, 'Food ordering', 'Direct ordering, a kitchen screen and marketing automations, without the aggregator’s cut.', '{"client":"","problem":"","built":"","results":""}'::jsonb, '{}'::text[], null, 'https://farm-pizza.shop', '{"desktop":"/work/takeaway-platform-desktop.jpg","mobile":"/work/takeaway-platform-mobile.jpg"}'::jsonb, false, 'product', 'published', 'in-testing', false, null, 'farm-pizza.shop', 'Direct ordering for takeaways, without the aggregator''s cut.', 'A storefront, kitchen screen and back office for a takeaway, with Apple Pay and Google Pay, automated win-back and quiet-night campaigns, abandoned-basket recovery and search built in. Everything per shop is configuration, so the next shop is a folder and a deploy. Farm Pizza is the first tenant.', array['Next.js and Stripe', 'Kitchen pass screen', 'Marketing automations built in', 'Customer app specified']::text[], 19, now()
FROM "organisations" o
ON CONFLICT ("organisation_id", "slug") DO NOTHING;
