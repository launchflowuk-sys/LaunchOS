import { redirect } from "next/navigation";

// Plan 1 shipped this list at /tickets; spec section 5 names the screen "Open
// Cases", so the list now lives at /cases. The old route stays as a redirect
// because the dashboard, global search and owner notifications all link here.
export default function TicketsPage() {
  redirect("/cases");
}
