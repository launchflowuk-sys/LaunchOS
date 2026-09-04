export type DomainEvent =
  | { name: "incident.opened"; organisationId: string; incidentId: string }
  | { name: "ticket.created"; organisationId: string; ticketId: string }
  | { name: "client.created"; organisationId: string; clientId: string }
  | { name: "site.created"; organisationId: string; siteId: string }
  | { name: "domain.created"; organisationId: string; domainId: string }
  | { name: "member.created"; organisationId: string; memberId: string };

export type EnqueueFn = (event: DomainEvent) => Promise<void>;
let enqueue: EnqueueFn = async () => {}; // no-op until the worker or web sets one

export function setEnqueue(fn: EnqueueFn) { enqueue = fn; }
export async function emit(event: DomainEvent) { await enqueue(event); }
