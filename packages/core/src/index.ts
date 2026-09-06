export { recordAudit, RecordAuditInput } from "./audit/record-audit.js";
export {
  supportEmailDomain,
  supportEmailFor,
  DEFAULT_SUPPORT_EMAIL_DOMAIN,
  appUrl,
  brandLogoUrl,
  brandSupportAddress,
  brandEmailContext,
  BRAND_LOGO_PATH,
  LOCAL_APP_URL,
  DEFAULT_FIRST_RESPONSE_HOURS,
  firstResponseHours,
  type BrandEmailContext,
} from "./config.js";
export { truncate, MAX_ADDRESS_CHARS, MAX_ERROR_CHARS } from "./text.js";
export { updateOrganisation, UpdateOrganisationInput } from "./organisations/update-organisation.js";
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
export { ensureEmailIdentity, supportAddress, EnsureEmailIdentityInput } from "./email/ensure-email-identity.js";
export { ingestInboundEmail, HOLDING_CLIENT_SLUG } from "./support/ingest-inbound-email.js";
export { slaDueAt, SLA_HOURS_BY_SEVERITY } from "./support/sla.js";
export type { Severity } from "./support/sla.js";
export { updateTicket, UpdateTicketInput, TicketTriageSchema } from "./support/update-ticket.js";
export { setTicketClientVisibility, SetTicketClientVisibilityInput } from "./support/set-ticket-client-visibility.js";
export { assignTicket, AssignTicketInput } from "./support/assign-ticket.js";
export { escalateTicket, EscalateTicketInput } from "./support/escalate-ticket.js";
export { replyToConversation, ReplyToConversationInput } from "./support/reply-to-conversation.js";
export {
  isCourtesyNotice, isCourtesyNoticeRow, COURTESY_NOTICE_KINDS,
  PORTAL_REPLY_NOTICE_KIND, CASE_ACKNOWLEDGEMENT_KIND, SUBSCRIPTION_CHANGE_NOTICE_KIND,
} from "./support/courtesy-notice.js";
export type { CourtesyNoticeKind } from "./support/courtesy-notice.js";
export { queueCaseAcknowledgement, acknowledgementBody, caseReference, ACKNOWLEDGED_AT } from "./support/acknowledge-ticket.js";
export type { QueueCaseAcknowledgementInput } from "./support/acknowledge-ticket.js";
export { replyAsClient, ReplyAsClientInput } from "./support/reply-as-client.js";
export { sendQueuedMessage, SendQueuedMessageInput, MAX_SEND_ATTEMPTS, CLAIM_TTL_MINUTES } from "./support/send-queued-message.js";
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
export {
  encryptSecret, decryptSecret, loadEncryptionKey, parseEncryptionKey, isEncryptionConfigured,
  SecretsKeyError, SecretsDecryptError, SECRETS_ENCRYPTION_KEY_ENV,
} from "./secrets/encryption.js";
export {
  setSiteCmsCredential, getSiteCmsCredential, getSiteCmsCredentialStatus, siteCredentialResolver,
  SetSiteCmsCredentialInput,
} from "./sites/site-credentials.js";
export type { SiteCmsCredential, SiteCmsCredentialStatus } from "./sites/site-credentials.js";
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
export { reissueOneTimePassword, ReissueOneTimePasswordInput } from "./team/reissue-password.js";
export { recordOwnPasswordChange, RecordOwnPasswordChangeInput } from "./team/record-own-password-change.js";
export type { RecordOwnPasswordChangeResult } from "./team/record-own-password-change.js";
export {
  PERMISSION_KEYS, PERMISSION_LABELS, defaultPermissions, resolvePermissions,
  getMemberPermissions, setMemberPermissions, hasPermission, assertPermission, PermissionDenied,
  GetMemberPermissionsInput, SetMemberPermissionsInput,
} from "./team/permissions.js";
export type { MemberPermissions, PermissionKey, MemberPermissionsRow } from "./team/permissions.js";
export {
  clockIn, clockOut, startTimer, stopTimer, getRunningEntry,
  ClockInInput, ClockOutInput, StartTimerInput, GetRunningEntryInput,
} from "./team/time-entries.js";
export type { TimeEntry } from "./team/time-entries.js";
export { listTimesheet, teamTimesheets, ListTimesheetInput, TeamTimesheetsInput } from "./team/timesheets.js";
export type { Timesheet, TimesheetDay, TimesheetEntry, TeamTimesheets, MemberTimesheet } from "./team/timesheets.js";
export { weekBounds, mondayOf, addCalendarDays, londonDayStart, londonDayOf, entryMinutes, formatMinutes } from "./team/week.js";
export type { WeekBounds, IsoDate } from "./team/week.js";
export { teamHealth, TeamHealthInput, OPEN_TICKET_STATUSES } from "./team/team-health.js";
export type { TeamHealth, MemberHealth } from "./team/team-health.js";
export {
  createOpsBrief, latestOpsBrief, getOpsBrief, listOpsBriefs,
  CreateOpsBriefInput, GetOpsBriefInput, ListOpsBriefsInput, OpsBriefHighlightSchema,
} from "./team/ops-briefs.js";
export type { OpsBrief, OpsBriefHighlight } from "./team/ops-briefs.js";
export { opsMetricsSnapshot, OpsMetricsInput } from "./team/ops-metrics.js";
export type { OpsMetricsSnapshot, MoneyCount } from "./team/ops-metrics.js";
export { recentOpsActivity, RecentOpsActivityInput } from "./team/ops-activity.js";
export type { RecentOpsActivity, OpsTimelineItem } from "./team/ops-activity.js";
export { search, SearchInput } from "./search/search.js";
export type { SearchResults } from "./search/search.js";
export { createPackage, CreatePackageInput, PackageIncludesInput } from "./packages/create-package.js";
export { updatePackage, UpdatePackageInput } from "./packages/update-package.js";
export { getPackage, listPackages, ListPackagesInput } from "./packages/list-packages.js";
export { createTaskTemplate, CreateTaskTemplateInput, TaskTemplateFields } from "./packages/create-task-template.js";
export { deleteTaskTemplate, updateTaskTemplate, DeleteTaskTemplateInput, UpdateTaskTemplateInput } from "./packages/update-task-template.js";
export { listTaskTemplates, ListTaskTemplatesInput } from "./packages/list-task-templates.js";
export { addDays, dueWithinPeriod, londonDateKey, periodBounds, ukDateRange, ukLongDate } from "./tasks/dates.js";
export type { Period } from "./tasks/dates.js";
export { createTask, CreateTaskInput } from "./tasks/create-task.js";
export { listTasks, TaskFilters } from "./tasks/list-tasks.js";
export type { TaskListRow } from "./tasks/list-tasks.js";
export { getTask } from "./tasks/get-task.js";
export { updateTaskStatus, UpdateTaskStatusInput, FINISHED_STATUSES } from "./tasks/update-task-status.js";
export { findOwnerUserId, pickLeastLoadedStaff } from "./tasks/assignee.js";
export { assignTask, AssignTaskInput } from "./tasks/assign-task.js";
export { commentOnTask, CommentOnTaskInput } from "./tasks/comment-on-task.js";
export { setTaskVisibility, toggleChecklistItem, SetTaskVisibilityInput, ToggleChecklistItemInput } from "./tasks/toggle-checklist-item.js";
export { generateOnboardingTasks } from "./tasks/generate-onboarding-tasks.js";
export { generateRecurringTasks, quantityFor, GenerateRecurringTasksInput } from "./tasks/generate-recurring-tasks.js";
export { findOverdueTasks, notifyOverdueTasks, OverdueInput } from "./tasks/find-overdue-tasks.js";
export { createKnowledgeArticle, CreateKnowledgeArticleInput, slugifyArticleTitle } from "./knowledge/create-article.js";
export { updateKnowledgeArticle, UpdateKnowledgeArticleInput } from "./knowledge/update-article.js";
export { deleteKnowledgeArticle, DeleteKnowledgeArticleInput } from "./knowledge/delete-article.js";
export { listKnowledgeArticles } from "./knowledge/list-articles.js";
export type { ListKnowledgeArticlesInput } from "./knowledge/list-articles.js";
export { searchKnowledge, KNOWLEDGE_SEARCH_LIMIT } from "./knowledge/search-knowledge.js";
export type { KnowledgeHit } from "./knowledge/search-knowledge.js";
export { createClientUser, CreateClientUserInput } from "./client-users/create-client-user.js";
export { listClientUsers } from "./client-users/list-client-users.js";
export { setClientUserStatus, SetClientUserStatusInput } from "./client-users/set-client-user-status.js";
export type { ClientUserRow } from "./client-users/list-client-users.js";
export {
  createSubscription, cancelSubscription, activeSubscriptionForClient,
  CreateSubscriptionServiceInput, CancelSubscriptionInput,
} from "./billing/subscriptions.js";
export { nextInvoiceNumber, INVOICE_NUMBER_PREFIX } from "./billing/invoice-number.js";
export {
  createInvoiceFromSubscription, markInvoiceSent, markInvoicePaid, voidInvoice,
  CreateInvoiceFromSubscriptionInput, MarkInvoicePaidInput,
  VAT_RATE_DEFAULT_PERCENT, PAYMENT_TERMS_DEFAULT_DAYS,
} from "./billing/invoices.js";
export { findOverdueInvoices, FindOverdueInvoicesInput } from "./billing/overdue.js";
export type { OverdueOutcome } from "./billing/overdue.js";
export {
  createAdAccount, updateAdAccount, listAdAccounts, CreateAdAccountInput, UpdateAdAccountInput, CurrencyCode,
} from "./ads/accounts.js";
export type { AdAccountRow } from "./ads/accounts.js";
export { ingestDailyMetrics, IngestDailyMetricsInput } from "./ads/ingest.js";
export type { IngestResult } from "./ads/ingest.js";
export {
  computeAccountSignals, SIGNAL_WINDOW_DAYS, ROAS_DROP_THRESHOLD_PERCENT, CPC_RISE_THRESHOLD_PERCENT,
} from "./ads/signals.js";
export type { AccountSignals, SignalWindow } from "./ads/signals.js";
export {
  saveDraftAdReport, approveAdReport, sendAdReport, SaveDraftAdReportInput, AdReportActionInput,
} from "./ads/reports.js";
export { recordPayment, reconcileInvoice, RecordPaymentInput } from "./billing/payments.js";
export { findOrganisationByStripeCustomer, syncFromPaymentsEvent } from "./billing/webhook-sync.js";
export type { SyncResult } from "./billing/webhook-sync.js";
export {
  requestInvoiceSend, sendApprovedInvoice, INVOICE_SEND_ACTION,
  RequestInvoiceSendInput, SendApprovedInvoiceInput,
} from "./billing/invoice-send.js";
export {
  findPendingInvoiceSendApproval, requestInvoiceSendOnce,
} from "./billing/invoice-send-requests.js";
export {
  requestSubscriptionChange, findPendingSubscriptionChange, latestSubscriptionChange,
  isPendingSubscriptionChangeCollision, SubscriptionChangeRefused,
  RequestSubscriptionChangeInput, SubscriptionChangePayload,
  SUBSCRIPTION_CHANGE_ACTION, SUBSCRIPTION_CHANGE_KINDS, SUBSCRIPTION_CHANGE_LABEL, PENDING_SUBSCRIPTION_CHANGE_INDEX,
} from "./billing/subscription-change-request.js";
export type { SubscriptionChangeKind } from "./billing/subscription-change-request.js";
export {
  applySubscriptionChangeDecision, ApplySubscriptionChangeDecisionInput,
} from "./billing/subscription-change-decision.js";
export type { ApplySubscriptionChangeDecisionResult } from "./billing/subscription-change-decision.js";
export { decideApproval, DecideApprovalInput } from "./approvals/decide-approval.js";
export type { ApprovalRow, DecideApprovalResult } from "./approvals/decide-approval.js";
export { buildClientReport, monthPeriod } from "./reports/build-client-report.js";
export type { ReportPeriod } from "./reports/build-client-report.js";
export { publishClientReport, PublishClientReportInput } from "./reports/publish.js";
export { listClientReports, getClientReport, ListClientReportsInput } from "./reports/list-client-reports.js";
export {
  ContentRefused, CHANNEL_LABEL, KIND_FOR_CHANNEL, TASK_KIND_FOR_CHANNEL, EDITABLE_STATUSES, CANCELLABLE_STATUSES,
  MAX_CONTENT_BODY_CHARS, MAX_CONTENT_TITLE_CHARS, PeriodKeySchema, periodKeyFor, shortLondonDate, monthName, excerpt,
} from "./content/shared.js";
export type {
  ContentRefusedReason, ContentItemRow, ContentBriefRow, ContentChannelRow, ContentReportRow,
} from "./content/shared.js";
export { spreadSlotTimes, weekdaysOf, londonAt, londonOffsetMinutes, parsePeriodKey, PUBLISH_HOUR_LONDON } from "./content/schedule.js";
export { upsertContentBrief, getContentBrief, UpsertContentBriefInput, GetContentBriefInput } from "./content/briefs.js";
export { setContentChannel, listContentChannels, SetContentChannelInput, ListContentChannelsInput } from "./content/channels.js";
export {
  createContentItem, updateContentItem, getContentItem, listContentItems, cancelContentItem,
  CreateContentItemInput, UpdateContentItemInput, GetContentItemInput, ListContentItemsInput, CancelContentItemInput,
} from "./content/items.js";
export type { ContentItemListRow, ContentItemDetail } from "./content/items.js";
export { planContentMonth, slotsFor, PlanContentMonthInput } from "./content/plan-month.js";
export type { PlanContentMonthResult } from "./content/plan-month.js";
export {
  requestContentApproval, applyContentPublishDecision, contentPublishSummary,
  RequestContentApprovalInput, ApplyContentPublishDecisionInput, ContentPublishPayload,
  CONTENT_PUBLISH_ACTION, PENDING_CONTENT_PUBLISH_INDEX,
} from "./content/approval.js";
export type { ApplyContentPublishDecisionResult } from "./content/approval.js";
export {
  claimDueContent, markContentPublished, markContentFailed, MAX_CONTENT_PUBLISH_ATTEMPTS,
  ClaimDueContentInput, MarkContentPublishedInput, MarkContentFailedInput,
} from "./content/publishing.js";
export type { MarkContentFailedResult } from "./content/publishing.js";
export { suggestContentItem, SuggestContentItemInput } from "./content/suggest.js";
export { buildContentReport, BuildContentReportInput } from "./content/report.js";

// ---- Remote pack (W1): push, SLA, evidence, assignment, CSAT, content report send, assets, heartbeat, leads, signup ----
export { getNotification } from "./notifications/list-notifications.js";
export { URGENT_NOTIFICATION_KINDS, pushForNotification } from "./push/urgent.js";
export type { UrgentNotificationKind } from "./push/urgent.js";
export {
  savePushSubscription, removePushSubscription, listPushSubscriptions, countPushSubscriptions, recordPushDelivery,
  SavePushSubscriptionInput, RemovePushSubscriptionInput, ListPushSubscriptionsInput, RecordPushDeliveryInput,
} from "./push/subscriptions.js";
export type { PushSubscriptionRow } from "./push/subscriptions.js";
export {
  casesPastFirstResponse, notifySlaBreaches, CasesPastFirstResponseInput, NotifySlaBreachesInput,
  SLA_BREACH_NOTIFIED_AT, SLA_BREACH_NOTIFICATION_KIND, AWAITING_RESPONSE_STATUSES,
} from "./sla/first-response.js";
export type { SlaBreachResult } from "./sla/first-response.js";
export {
  TaskEvidenceMissing, TaskTemplateEvidenceInput, TaskEvidenceInput, evidenceFromTemplate, evidenceSatisfied,
  templateForTask, assertTaskEvidence, taskEvidenceStatus, addTaskEvidenceLink, uploadTaskAttachment, removeTaskEvidence, tickChecklistItem,
  AddTaskEvidenceLinkInput, UploadTaskAttachmentInput, RemoveTaskEvidenceInput, TickChecklistItemInput,
} from "./tasks/evidence.js";
export type { EvidenceCheck } from "./tasks/evidence.js";
export {
  AssignmentRules, DEFAULT_ASSIGNMENT_RULES, SUPPORT_ASSIGNMENT_RULES, TASK_ASSIGNMENT_RULES,
  SUPPORT_ASSIGNMENT_LABELS, TASK_ASSIGNMENT_LABELS, ASSIGNMENT_METADATA_KEY,
  assignmentRulesFrom, getAssignmentRules, setAssignmentRules, supportAssignmentOn, taskAssignmentOn, SetAssignmentRulesInput,
} from "./assignment/rules.js";
export type { SupportAssignmentRule, TaskAssignmentRule } from "./assignment/rules.js";
export { pickAssignee, roundRobinCursor, PickAssigneeInput, CONTENT_TASK_KINDS } from "./assignment/pick-assignee.js";
export { autoAssignTicket, autoAssignTask, AutoAssignTicketInput, AutoAssignTaskInput } from "./assignment/auto-assign.js";
export type { AutoAssignment } from "./assignment/auto-assign.js";
export { CSAT_INVITE_KIND, CONTENT_REPORT_NOTICE_KIND } from "./support/courtesy-notice.js";
export { queueCsatInvite, csatInviteBody, csatRatePath, CSAT_INVITED_AT, CSAT_SCORES, CSAT_SCORE_LABELS } from "./csat/invite.js";
export type { QueueCsatInviteInput } from "./csat/invite.js";
export {
  rateTicket, getTicketRating, CsatRefused, RateTicketInput, GetTicketRatingInput, CSAT_LOW_SCORE, CSAT_LOW_SCORE_NOTIFICATION_KIND,
} from "./csat/rate-ticket.js";
export type { TicketRatingRow } from "./csat/rate-ticket.js";
export { csatSummary, CsatSummaryInput } from "./csat/summary.js";
export type { CsatSummary, CsatMemberSummary, CsatScoreLine } from "./csat/summary.js";
export {
  requestContentReportSend, applyContentReportSendDecision, contentReportSendSummary, contentReportEmailBody,
  RequestContentReportSendInput, ApplyContentReportSendDecisionInput, ContentReportSendPayload,
  CONTENT_REPORT_SEND_ACTION, PENDING_CONTENT_REPORT_SEND_INDEX,
} from "./content/report-send.js";
export type { ApplyContentReportSendDecisionResult } from "./content/report-send.js";
export {
  createContentAsset, listContentAssets, getContentAsset, deleteContentAsset, readContentAsset, publicAssetUrl, contentAssetFilePath,
  ContentAssetRefused, CreateContentAssetInput, ListContentAssetsInput, GetContentAssetInput, DeleteContentAssetInput,
  CONTENT_ASSET_MIMES, MAX_CONTENT_ASSET_BYTES, ASSET_ROUTE_PATH,
} from "./assets/content-assets.js";
export type { ContentAssetRow, ContentAssetMime } from "./assets/content-assets.js";
export {
  recordHeartbeat, heartbeatAge, ensureHeartbeatRow, mergeHeartbeatDetails, RecordHeartbeatInput, HeartbeatAgeInput,
  WORKER_HEARTBEAT_NAME, WORKER_HEARTBEAT_INTERVAL_MS, WORKER_DOWN_AFTER_MS,
} from "./heartbeat/heartbeat.js";
export type { HeartbeatRow, HeartbeatAge } from "./heartbeat/heartbeat.js";
export {
  checkWorkerDown, noteSystemError, CheckWorkerDownInput, NoteSystemErrorInput,
  WORKER_DOWN_ALERT_NAME, SYSTEM_ERRORS_NAME, WORKER_DOWN_NOTIFICATION_KIND, SYSTEM_ERROR_NOTIFICATION_KIND, SYSTEM_ERROR_THROTTLE_MS,
} from "./heartbeat/alerts.js";
export type { WorkerStatus, SystemErrorNote } from "./heartbeat/alerts.js";
export {
  createLead, listLeads, getLead, updateLeadStatus, convertLeadToClient,
  CreateLeadInput, ListLeadsInput, UpdateLeadStatusInput, ConvertLeadToClientInput, LEAD_STATUSES, LEAD_NOTIFICATION_KIND,
} from "./leads/leads.js";
export type { LeadRow } from "./leads/leads.js";
export {
  createSignupSession, completeSignup, signupOrganisationFromEvent, SignupRefused, CreateSignupSessionInput, CompleteSignupInput,
  SIGNUP_MARKER, SIGNUP_LEAD_SOURCE, SIGNUP_COMPLETED_NOTIFICATION_KIND, SIGNUP_CLAIM_TTL_MS,
} from "./signup/signup.js";
export type { SignupDeps, SignupSessionResult, CompleteSignupResult } from "./signup/signup.js";
