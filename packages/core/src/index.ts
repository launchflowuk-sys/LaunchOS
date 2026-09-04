export { recordAudit, RecordAuditInput } from "./audit/record-audit.js";
export { supportEmailDomain, supportEmailFor, DEFAULT_SUPPORT_EMAIL_DOMAIN } from "./config.js";
export { createClient, CreateClientInput } from "./clients/create-client.js";
export { updateClient, archiveClient, UpdateClientInput, ArchiveClientInput } from "./clients/update-client.js";
export { listClients, getClient, escapeLike, ListClientsInput } from "./clients/list-clients.js";
export type { ClientListRow } from "./clients/list-clients.js";
export { slugify, uniqueClientSlug } from "./clients/slug.js";
export { createSite, CreateSiteInput } from "./sites/create-site.js";
export { createMonitor, CreateMonitorInput } from "./monitoring/create-monitor.js";
export { recordCheck, RecordCheckInput, FAILURE_THRESHOLD } from "./monitoring/record-check.js";
export { openIncident, OpenIncidentInput } from "./incidents/open-incident.js";
export { updateIncident, UpdateIncidentInput } from "./incidents/update-incident.js";
export { createTicket, CreateTicketInput } from "./support/create-ticket.js";
export {
  assertOwned, assertClientInOrganisation, assertSiteInOrganisation, assertOrgMember,
} from "./tenancy/assert-owned.js";
export type { OwnedTable } from "./tenancy/assert-owned.js";
export { emit, setEnqueue } from "./events/emit.js";
export type { DomainEvent, EnqueueFn } from "./events/emit.js";
export { recordActivity, RecordActivityInput } from "./activity/record-activity.js";
export { listActivity, ListActivityInput } from "./activity/list-activity.js";
export { notify, notifyOwner, NotifyInput, NotifyOwnerInput } from "./notifications/notify.js";
export {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  ListNotificationsInput,
  MarkReadInput,
} from "./notifications/list-notifications.js";
export {
  createContact, updateContact, deleteContact, listContacts,
  CreateContactInput, UpdateContactInput, DeleteContactInput,
} from "./clients/contacts.js";
export { upsertBillingProfile, getBillingProfile, UpsertBillingProfileInput } from "./billing/upsert-billing-profile.js";
export { updateSite, UpdateSiteInput } from "./sites/update-site.js";
export { listSites, getSite, ListSitesInput } from "./sites/list-sites.js";
export type { SiteListRow } from "./sites/list-sites.js";
export {
  createDomain, updateDomain, deleteDomain, listDomains, getDomain,
  CreateDomainInput, UpdateDomainInput, DeleteDomainInput, ListDomainsInput,
} from "./domains/domains.js";
export type { DomainListRow } from "./domains/domains.js";
export {
  createDnsRecord, updateDnsRecord, deleteDnsRecord, listDnsRecords,
  CreateDnsRecordInput, UpdateDnsRecordInput, DeleteDnsRecordInput,
} from "./domains/dns-records.js";
export { generateOneTimePassword } from "./team/password.js";
export { createMember, CreateMemberInput } from "./team/create-member.js";
export { listMembers, countActiveOwners } from "./team/list-members.js";
export type { MemberRow } from "./team/list-members.js";
export { deactivateMember, DeactivateMemberInput } from "./team/deactivate-member.js";
export { search, SearchInput } from "./search/search.js";
export type { SearchResults } from "./search/search.js";
