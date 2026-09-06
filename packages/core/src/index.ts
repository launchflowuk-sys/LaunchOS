export { recordAudit, RecordAuditInput } from "./audit/record-audit.js";
export {
  recordTwoFactorEvent, isStaffUser, TWO_FACTOR_EVENTS, RecordTwoFactorEventInput,
} from "./security/two-factor-events.js";
export type { TwoFactorEvent, TwoFactorEventResult } from "./security/two-factor-events.js";
export {
  staffTwoFactorRequired, staffWithoutTwoFactor, setStaffTwoFactorRequired,
  SetStaffTwoFactorRequiredInput, TwoFactorPolicyRefused,
} from "./security/two-factor-policy.js";
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
export { mergeClients, mergePreview, MergeRefused, MergeClientsInput, MergePreviewInput } from "./clients/merge-clients.js";
export type { MergeClientsResult, MergePreview, MergeCounts } from "./clients/merge-clients.js";
export { MOVE_SPECS } from "./clients/merge-clients-tables.js";
export {
  getClientBrand, setClientBrand, clientBrandFrom,
  ClientBrandSchema, GetClientBrandInput, SetClientBrandInput,
  BRAND_METADATA_KEY, DEFAULT_BRAND_PRIMARY, DEFAULT_BRAND_ACCENT,
} from "./clients/brand.js";
export type { ClientBrand, ResolvedClientBrand } from "./clients/brand.js";
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
export {
  createAccessEntry, updateAccessEntry, deleteAccessEntry, listAccessEntries,
  CreateAccessEntryInput, UpdateAccessEntryInput, DeleteAccessEntryInput,
  ACCESS_KINDS, ACCESS_KIND_LABELS, ACCESS_TARGET_TYPE,
} from "./access/access-entries.js";
export type { AccessEntryRow, AccessKind } from "./access/access-entries.js";
export { revealAccessSecret, RevealAccessSecretInput } from "./access/reveal-access-secret.js";
export type { RevealedAccessSecret } from "./access/reveal-access-secret.js";
export { listAccessLocations, ACCESS_PORTAL_PATH } from "./access/access-entries.js";
export type { AccessLocation } from "./access/access-entries.js";
export { accessLog, ACCESS_LOG_LIMIT } from "./access/access-log.js";
export type { AccessLogRow } from "./access/access-log.js";
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
export { findOrganisationByStripeCustomer, checkoutOrganisationFromEvent, syncFromPaymentsEvent } from "./billing/webhook-sync.js";
export type { SyncResult, SyncDeps } from "./billing/webhook-sync.js";
export {
  previewStripeSync, applyStripeSync, reconcileStripe, importStripeSubscription, businessCase, isSuggestedProduct, proposedClientName,
  ApplyStripeSyncInput, STRIPE_SYNC_NOTIFICATION_KIND, STRIPE_CLIENT_CREATED_NOTIFICATION_KIND, STRIPE_STATUS_CHANGED_NOTIFICATION_KIND,
} from "./billing/stripe-sync.js";
export type {
  StripeSyncPreview, StripeSyncPreviewProduct, StripeSyncPreviewSubscription, ImportedSubscription, MatchedBy, StripeSyncCandidate,
} from "./billing/stripe-sync.js";
export {
  attachPaymentAccount, findClientByStripeCustomer, customerClaimedElsewhere, listPaymentAccounts, STRIPE_PROVIDER,
} from "./billing/payment-accounts.js";
export type { AttachPaymentAccountOutcome } from "./billing/payment-accounts.js";
export {
  getStripeSyncSettings, setStripeSyncSettings, stripeSyncSettingsFrom, soleActiveOrganisationId,
  StripeSyncSettings, StripeSyncSummary, STRIPE_SYNC_METADATA_KEY,
} from "./billing/stripe-sync-settings.js";
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
export type { ReportActor } from "./reports/build-client-report.js";
// P5c — the monthly account report: the client report, compiled into one PDF.
export {
  buildMonthlyReport, renderMonthlyReport, londonMonthPeriod, reportMonthName,
  monthlyReportDocumentHtml, monthlyReportRenderInput, monthlyReportReference, monthlyReportTitle,
  BuildMonthlyReportInput, RenderMonthlyReportInput,
  MONTHLY_REPORT_DOCUMENT_KIND, MONTHLY_REPORT_SUBJECT_TYPE, CLIENT_REPORT_TARGET_TYPE, REPORT_TIME_ZONE,
} from "./reports/monthly-report.js";
export type {
  MonthlyReportResult, RenderMonthlyReportResult, MonthlyReportDeps, MonthlyReportDocumentInput,
} from "./reports/monthly-report.js";
export { documentBodyFromMarkdown } from "./reports/markdown-document.js";
export type { ReportPeriod } from "./reports/build-client-report.js";
export { publishClientReport, publishClientReportTx, PublishClientReportInput } from "./reports/publish.js";
// The `report_send` gate: nothing reaches a client until a person has read it.
export {
  requestMonthlyReportSend, applyMonthlyReportSendDecision, monthlyReportSendDecided,
  monthlyReportSendSummary, monthlyReportEmailBody, monthlyReportMonthName, ReportRefused,
  RequestMonthlyReportSendInput, ApplyMonthlyReportSendDecisionInput, MonthlyReportSendPayload,
  MONTHLY_REPORT_SEND_ACTION, MONTHLY_REPORT_SEND_KIND, PENDING_MONTHLY_REPORT_SEND_INDEX,
} from "./reports/report-send.js";
export type { ApplyMonthlyReportSendDecisionResult, ReportRefusalReason } from "./reports/report-send.js";
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
export { renderTemplateImage, RenderTemplateImageInput, IMAGE_TEMPLATE_SIZES } from "./content/image-template.js";
export type { ImageTemplateSize, RenderedTemplateImage } from "./content/image-template.js";
export { headlineFrom, kickerFrom } from "./content/image-headline.js";
export {
  estimatePence, imagegenSpentThisMonth, monthlyCapPence,
  IMAGE_METADATA_KEY, IMAGEGEN_MONTHLY_CAP_VARIABLE, DEFAULT_IMAGEGEN_MONTHLY_CAP_PENCE,
} from "./content/image-budget.js";
export {
  renderContentImage, channelTakesImage, RenderContentImageInput,
  IMAGE_CHANNELS, IMAGE_RENDERABLE_STATUSES, BRIEF_IMAGES_METADATA_KEY,
} from "./content/render-image.js";
export type {
  RenderContentImageDeps, RenderContentImageResult, RenderedContentImage, RefusedContentImage, ImageFallbackReason,
} from "./content/render-image.js";
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
  createLead, listLeads, getLead, getLeadWithAttribution, updateLeadStatus, markLeadContacted, convertLeadToClient,
  leadCampaignCounts, leadsAwaitingReply,
  CreateLeadInput, ListLeadsInput, UpdateLeadStatusInput, ConvertLeadToClientInput, LeadCampaignCountsInput, LeadsAwaitingReplyInput,
  LEAD_STATUSES, LEAD_NOTIFICATION_KIND,
} from "./leads/leads.js";
export type { LeadRow, LeadCampaignCount } from "./leads/leads.js";

// ---- Client workflow (X1): lead acknowledgement, attribution, qualifier reply, meetings ----
export {
  LeadAttributionSchema, ATTRIBUTION_METADATA_KEY, attributionOf, attributionSummary, compactAttribution, hasAttribution,
} from "./leads/attribution.js";
export type { LeadAttribution } from "./leads/attribution.js";
export {
  bookingLinkFor, bookingTokenOf, mintBookingToken, findLeadByBookingToken, findLeadByBookingTokenIn, ensureBookingToken, marketingUrl,
  BOOKING_TOKEN_KEY, BOOKING_PATH, DEFAULT_MARKETING_URL,
} from "./leads/booking-link.js";
export {
  queueLeadAcknowledgement, ensureLeadConversation, leadAcknowledgementBody,
  LEAD_ACKNOWLEDGED_AT, LEAD_CONVERSATION_ID, ACKNOWLEDGED_LEAD_SOURCES,
} from "./leads/acknowledge.js";
export type { QueueLeadAcknowledgementInput } from "./leads/acknowledge.js";
export {
  requestLeadReply, applyLeadReplyDecision, listLeadMessages, leadReplyBody, LeadReplyRefused,
  RequestLeadReplyInput, ApplyLeadReplyDecisionInput, LeadReplyPayload, LEAD_REPLY_ACTION, PENDING_LEAD_REPLY_INDEX,
} from "./leads/reply.js";
export type { ApplyLeadReplyDecisionResult } from "./leads/reply.js";
export { LEAD_ACKNOWLEDGEMENT_KIND, MEETING_NOTICE_KIND } from "./support/courtesy-notice.js";
export { LEAD_REPLY_KIND } from "./support/send-queued-message.js";
export {
  BookingSettingsSchema, DEFAULT_BOOKING_SETTINGS, BOOKING_METADATA_KEY, DAY_KEYS,
  bookingSettingsFrom, getBookingSettings, setBookingSettings, defaultHostUserId, resolveBookingHost, SetBookingSettingsInput,
} from "./meetings/settings.js";
export type { BookingSettings, BookingHours, BookingWindow, DayKey } from "./meetings/settings.js";
export {
  isValidTimeZone, zonedParts, offsetMinutes, zonedTimeToUtc, zonedDateKey, zonedTimeKey, formatInZone, zoneAbbreviation, addDaysToKey, keyOfParts,
} from "./meetings/time.js";
export type { ZonedParts } from "./meetings/time.js";
export { availableSlots, isSlotAvailable, slotStartsFromSettings, collides, AvailableSlotsInput } from "./meetings/slots.js";
export type { Slot, AvailableSlotsResult } from "./meetings/slots.js";
export { buildIcs, icsDate, icsText, foldLine } from "./meetings/ics.js";
export type { IcsEventInput } from "./meetings/ics.js";
export {
  bookMeeting, meetingIcs, meetingIcsByToken, mintRescheduleToken, MeetingRefused, BookMeetingInput, MEETING_BOOKED_NOTIFICATION_KIND,
} from "./meetings/book.js";
export type { MeetingDeps, BookMeetingResult } from "./meetings/book.js";
export {
  meetingManageUrl, meetingIcsUrl, rebookUrl, describeMeetingTime, ensureMeetingConversation, queueMeetingNotice, MEETING_CONVERSATION_ID,
} from "./meetings/notices.js";
export type { MeetingRow, MeetingNoticeKind, QueueMeetingNoticeInput } from "./meetings/notices.js";
export {
  getMeeting, getMeetingByToken, listMeetings, nextMeeting, rescheduleMeeting, cancelMeeting, markMeetingOutcome, meetingsNeedingOutcome,
  ListMeetingsInput, RescheduleMeetingInput, CancelMeetingInput, MarkMeetingOutcomeInput,
  MEETING_RESCHEDULED_NOTIFICATION_KIND, MEETING_CANCELLED_NOTIFICATION_KIND, NO_SHOW_EMAILED_AT,
} from "./meetings/manage.js";
export {
  sendMeetingReminders, followUpMeetings,
  MEETING_STARTING_NOTIFICATION_KIND, MEETING_OUTCOME_NOTIFICATION_KIND,
  REMINDED_24H_AT, REMINDED_1H_AT, HOST_ALERTED_AT, OUTCOME_NUDGED_AT, REMINDER_24H_MS, REMINDER_1H_MS, HOST_ALERT_MS,
} from "./meetings/reminders.js";
export type { ReminderSweepResult, FollowUpSweepResult } from "./meetings/reminders.js";
export {
  createSignupSession, completeSignup, SignupRefused, CreateSignupSessionInput, CompleteSignupInput,
  SIGNUP_MARKER, SIGNUP_LEAD_SOURCE, SIGNUP_COMPLETED_NOTIFICATION_KIND, SIGNUP_CLAIM_TTL_MS,
} from "./signup/signup.js";
export type { SignupDeps, SignupSessionResult, CompleteSignupResult } from "./signup/signup.js";
export {
  storeDocument, getDocument, listDocuments, readDocumentBytes, documentFilePath,
  DocumentRefused, StoreDocumentInput, GetDocumentInput, ListDocumentsInput,
  DOCUMENT_KINDS, DOCUMENT_TARGET_TYPE, MAX_DOCUMENT_BYTES,
} from "./documents/store-document.js";
export type { DocumentRow, DocumentKind } from "./documents/store-document.js";
export {
  documentLinkKey, signDocumentToken, signedDocumentUrl, verifyDocumentToken,
  DOCUMENT_ROUTE_PATH, DOCUMENT_TOKEN_PARAM,
  DEFAULT_DOCUMENT_LINK_TTL_SECONDS, MAX_DOCUMENT_LINK_TTL_SECONDS,
} from "./documents/document-link.js";
export type { DocumentTokenResult, DocumentTokenRefusal, SignDocumentLinkInput } from "./documents/document-link.js";
export {
  readDocumentForOwner, readDocumentForClient, readSignedDocument, documentContentDisposition,
  ReadDocumentInput, ReadClientDocumentInput, ReadSignedDocumentInput,
} from "./documents/read-document.js";
export type { DocumentAccessResult, DocumentAccessRefusal } from "./documents/read-document.js";
export {
  ProposalRefused, PROPOSAL_TARGET_TYPE, PROPOSAL_SUBJECT_TYPE, PROPOSAL_PUBLIC_PATH,
  SIGNATURE_VIEWBOX, MAX_SIGNATURE_CHARS, SignaturePathSchema, signatureSvgMarkup,
  PROPOSAL_LIVE_STATUSES, PROPOSAL_DECIDED_STATUSES,
  mintProposalToken, normaliseProposalToken, proposalPublicUrl,
  proposalExpiresAt, hasExpired, formatValidUntil, nextProposalReference,
  getProposal, requireProposal, getProposalByToken, listProposalLines, getProposalAcceptance,
  proposalActorUserId, proposalRecipient,
} from "./proposals/shared.js";
export type { ProposalRow, ProposalLineRow, ProposalAcceptanceRow } from "./proposals/shared.js";
export {
  ProposalPricingShapeSchema, ProposalLineKindSchema, ProposalPricingInput, ProposalPricingSchema,
  LINE_KINDS_FOR_SHAPE, SHAPE_LABEL, DEFAULT_VAT_NOTE,
  MAX_LINE_QUANTITY, MAX_UNIT_PENCE, MAX_PROPOSAL_PENCE, PenceSchema, QuantitySchema,
  lineTotalPence, assertLineKindAllowed, proposalTotals, isPricedAtNothing, pricingFromLines,
  formatPence, describePricing,
} from "./proposals/pricing.js";
export type { PricedLine, ProposalTotals } from "./proposals/pricing.js";
export {
  createProposal, updateProposal, listProposals, getProposalDetail, getPublicProposal,
  CreateProposalInput, UpdateProposalInput, ListProposalsInput, ProposalScopeInput, ProposalLineInput,
  PROPOSAL_EDITABLE_STATUSES, DEFAULT_VALIDITY_DAYS,
} from "./proposals/crud.js";
export type { ProposalDetail } from "./proposals/crud.js";
export {
  addProposalLine, updateProposalLine, removeProposalLine, LINE_TARGET_TYPE,
  AddProposalLineInput, UpdateProposalLineInput, RemoveProposalLineInput,
} from "./proposals/lines.js";
export type { ProposalLinesResult } from "./proposals/lines.js";
export { proposalDocumentHtml, proposalDocumentTitle, proposalRenderInput } from "./proposals/document.js";
export type { ProposalDocumentInput } from "./proposals/document.js";
export {
  sendProposal, renderProposalDocument, SendProposalInput,
  PROPOSAL_DOCUMENT_KIND, PROPOSAL_SIGNED_DOCUMENT_KIND,
} from "./proposals/send.js";
export type { ProposalDeps, SendProposalResult } from "./proposals/send.js";
export {
  recordProposalView, declineProposal, RecordProposalViewInput, DeclineProposalInput,
  DECLINE_REASON, PROPOSAL_VIEWED_NOTIFICATION_KIND, PROPOSAL_DECLINED_NOTIFICATION_KIND,
} from "./proposals/public.js";
export type { ProposalViewResult, DeclineProposalResult } from "./proposals/public.js";
export { acceptProposal, AcceptProposalInput, PROPOSAL_ACCEPTED_NOTIFICATION_KIND } from "./proposals/accept.js";
export type { AcceptProposalResult } from "./proposals/accept.js";
// The other end of the payment link an accepted proposal opens.
export {
  completeProposalCheckout, CompleteProposalCheckoutInput,
  PROPOSAL_CHECKOUT_MARKER, PROPOSAL_PAID_NOTIFICATION_KIND, CHECKOUT_PAID_AT, CHECKOUT_PAID_SESSION_ID,
} from "./proposals/checkout.js";
export type { CompleteProposalCheckoutResult } from "./proposals/checkout.js";
export {
  setProposalFollowOn, queueProposalFollowOn, PROPOSAL_ACCEPTED_JOB, FOLLOW_ON_QUEUED_AT,
} from "./proposals/follow-on.js";
export type { ProposalAcceptedJobData, ProposalFollowOnFn } from "./proposals/follow-on.js";
export {
  expireProposals, nudgeUnopenedProposals, proposalsAwaitingFollowOn,
  ExpireProposalsInput, NudgeProposalsInput, NUDGED_AT, NUDGE_AFTER_DAYS,
  PROPOSAL_EXPIRED_NOTIFICATION_KIND, PROPOSAL_UNOPENED_NOTIFICATION_KIND,
} from "./proposals/sweeps.js";
export type { ExpireProposalsResult, NudgeProposalsResult } from "./proposals/sweeps.js";
export {
  ensureProposalConversation, queueProposalNotice, sentBody, acceptedBody, declinedBody, paymentBody, PROPOSAL_CONVERSATION_ID,
} from "./proposals/notices.js";
export type { ProposalNoticeKind, QueueProposalNoticeInput } from "./proposals/notices.js";
export {
  requestProposalApproval, applyProposalSendDecision, proposalSendsAwaitingApplication,
  RequestProposalApprovalInput, ApplyProposalSendDecisionInput, ProposalSendPayload,
  PROPOSAL_SEND_ACTION, PENDING_PROPOSAL_SEND_INDEX, PROPOSAL_SEND_APPLIED_AT,
} from "./proposals/approval.js";
export type { ApplyProposalSendDecisionResult } from "./proposals/approval.js";
export {
  PROPOSAL_NOTICE_KIND, PROJECT_UPDATE_NOTICE_KIND, PROJECT_MILESTONE_NOTICE_KIND,
  DELIVERY_NOTICE_KIND, CLIENT_REPORT_NOTICE_KIND,
} from "./support/courtesy-notice.js";
export {
  projectProgress, describeProgress, MAX_UNDELIVERED_PERCENT,
} from "./projects/progress.js";
export type { ProjectProgress, ProjectProgressInput, ProgressPhase, ProgressMilestone } from "./projects/progress.js";
export {
  ProjectRefused, STANDARD_PHASES, DateKeySchema,
  PROJECT_TARGET_TYPE, PHASE_TARGET_TYPE, MILESTONE_TARGET_TYPE, PROJECT_PORTAL_PATH,
  PROJECT_OPEN_STATUSES, PROJECT_CLOSED_STATUSES, PROJECT_PHASE_KEYS,
  getProjectRow, requireProject, getProjectForProposal,
  listProjectPhases, listProjectMilestones, requirePhaseOfProject, requireMilestoneOfProject,
} from "./projects/shared.js";
export type { ProjectRow, ProjectPhaseRow, ProjectMilestoneRow } from "./projects/shared.js";
export {
  createProject, updateProject, listProjects,
  CreateProjectInput, UpdateProjectInput, ListProjectsInput, ProjectPhaseInput, ProjectMilestoneInput,
  MAX_PROPOSAL_MILESTONES,
} from "./projects/crud.js";
export type { CreateProjectResult } from "./projects/crud.js";
export { getProject, UNPHASED } from "./projects/get-project.js";
export type { ProjectDetail, PhaseTaskCounts } from "./projects/get-project.js";
export { setPhaseStatus, SetPhaseStatusInput } from "./projects/phases.js";
export {
  addMilestone, updateMilestone, reachMilestone,
  AddMilestoneInput, UpdateMilestoneInput, ReachMilestoneInput,
} from "./projects/milestones.js";
export type { ReachMilestoneResult } from "./projects/milestones.js";
export { deliverProject, DeliverProjectInput, PROJECT_DELIVERED_NOTIFICATION_KIND } from "./projects/deliver.js";
export type { DeliverProjectResult } from "./projects/deliver.js";
export {
  CaseStudyRefused, CASE_STUDY_TARGET_TYPE, CASE_STUDY_PUBLIC_PATH, CASE_STUDY_PUBLIC_STATUSES,
  CaseStudyBriefInput, CaseStudyScreenshotsInput, CaseStudyPoweredByInput,
  getCaseStudy, requireCaseStudy, getCaseStudyBySlug, getCaseStudyForProject, uniqueCaseStudySlug,
} from "./case-studies/shared.js";
export type { CaseStudyRow } from "./case-studies/shared.js";
export {
  createCaseStudy, updateCaseStudy, listCaseStudies, reorderCaseStudies, ensureCaseStudyForProject,
  CreateCaseStudyInput, UpdateCaseStudyInput, ListCaseStudiesInput, ReorderCaseStudiesInput,
  EnsureCaseStudyForProjectInput,
} from "./case-studies/crud.js";
export { PORTFOLIO, PORTFOLIO_CLIENTS, PORTFOLIO_PRODUCTS, PORTFOLIO_SLUGS, CABIO } from "./case-studies/portfolio.js";
export type { CaseStudySeed } from "./case-studies/portfolio.js";
export { toWorkItem, toProduct, toCaseStudySeed } from "./case-studies/portfolio-view.js";
export type { PortfolioWorkItem, PortfolioProduct, PortfolioStatus } from "./case-studies/portfolio-view.js";
export { seedCaseStudies, SeedCaseStudiesInput } from "./case-studies/seed.js";
export type { SeedCaseStudiesResult } from "./case-studies/seed.js";
// P4b — the client review that never blocks anything.
export {
  ClientReviewRefused, CLIENT_REVIEW_ACTION, PENDING_CLIENT_REVIEW_INDEX, CLIENT_REVIEW_STALE_DAYS,
  CLIENT_REVIEW_COMMENTED_AT, CLIENT_REVIEW_COMMENTS, ClientReviewPayload,
  clientReviewTargetRef, commentsOf,
  requestClientReview, listClientReviews, getClientReview,
  approveClientReview, commentOnClientReview, staleClientReviews, withdrawClientReview,
  RequestClientReviewInput, ListClientReviewsInput, AnswerClientReviewInput, CommentOnClientReviewInput,
} from "./projects/client-review.js";
export type { ClientReviewComment, StaleClientReview } from "./projects/client-review.js";
// P4c — the Friday update: what the reporter reads, and the card it raises.
export { projectWeekActivity, projectsDueAnUpdate, ProjectWeekActivityInput, PROJECT_WEEK_MS } from "./projects/week-activity.js";
export type {
  ProjectWeekActivity, ProjectWeekPhase, ProjectWeekMilestone, ProjectDueAnUpdate,
} from "./projects/week-activity.js";
export {
  ProjectUpdateRefused, PROJECT_UPDATE_ACTION, PENDING_PROJECT_UPDATE_INDEX, PROJECT_UPDATE_APPLIED_AT,
  PROJECT_UPDATE_MAX_CHARS, PROJECT_UPDATE_DEFAULT_SUBJECT, ProjectUpdatePayload,
  requestProjectUpdateApproval, applyProjectUpdateDecision, projectUpdatesAwaitingApplication, projectUpdateRecipients,
  RequestProjectUpdateApprovalInput, ApplyProjectUpdateDecisionInput,
} from "./projects/update-approval.js";
export type { ApplyProjectUpdateDecisionResult } from "./projects/update-approval.js";
export { queueMilestoneNotice, milestoneNoticeBody, MILESTONE_EMAILED_AT, QueueMilestoneNoticeInput } from "./projects/milestone-notice.js";
export type { MilestoneNoticeResult } from "./projects/milestone-notice.js";
// P4d — the Case Study Writer's allow-list, and the publish it has to ask for.
export { caseStudyMaterial, CaseStudyMaterialInput, CASE_STUDY_MATERIAL_FIELDS } from "./case-studies/material.js";
export type { CaseStudyMaterial, CaseStudyMaterialPhase, CaseStudyMaterialMilestone } from "./case-studies/material.js";
export {
  publishCaseStudy, unpublishCaseStudy, whyNotPublishable, PublishCaseStudyInput, REQUIRED_BRIEF_SECTIONS,
} from "./case-studies/publish.js";
// P5 — the one acceptance mechanism, shared by proposals and delivery sign-off.
// `SignaturePathSchema`, `SIGNATURE_VIEWBOX`, `MAX_SIGNATURE_CHARS` and
// `signatureSvgMarkup` are already exported through `proposals/shared.js`,
// which re-exports them from here — one export, whichever path a caller found
// them by.
export { mintPublicToken, normalisePublicToken, AGREEMENT_EVIDENCE_FIELDS } from "./documents/acceptance.js";
// P5a — the delivery report and its sign-off.
export {
  DeliveryRefused, DELIVERY_TARGET_TYPE, DELIVERY_SUBJECT_TYPE, DELIVERY_DOCUMENT_KIND,
  DELIVERY_PUBLIC_PATH, SIGN_OFF_TARGET_TYPE,
  mintSignOffToken, normaliseSignOffToken, deliverySignOffUrl, getDeliverySignOff, getProjectBySignOffToken,
} from "./delivery/shared.js";
export type { DeliverySignOffRow } from "./delivery/shared.js";
export { buildDeliveryReport, BuildDeliveryReportInput } from "./delivery/report.js";
export type {
  DeliveryReport, DeliveryReportPhase, DeliveryReportMilestone, DeliveryReportSite,
  DeliveryReportMonitor, DeliveryReportCare,
} from "./delivery/report.js";
export {
  deliveryReportHtml, deliveryReportDocumentHtml, deliveryReportRenderInput,
  deliveryReportReference, deliveryReportTitle,
} from "./delivery/document.js";
export {
  renderDeliveryReport, sendDeliveryReport, countersignDeliveryReport, deliveryNoticeBody,
  RenderDeliveryReportInput, SendDeliveryReportInput,
} from "./delivery/send.js";
export type { DeliveryDeps, RenderDeliveryReportResult, SendDeliveryReportResult } from "./delivery/send.js";
export {
  signOffDelivery, getPublicDeliveryReport, SignOffDeliveryInput, DELIVERY_SIGNED_OFF_NOTIFICATION_KIND,
} from "./delivery/sign-off.js";
export type { SignOffDeliveryResult } from "./delivery/sign-off.js";
// P5b — the invoice PDF.
export {
  invoiceDocumentHtml, invoiceRenderInput, invoiceDocumentInput, invoiceDocumentTitle,
  ensureInvoiceDocument, EnsureInvoiceDocumentInput, INVOICE_DOCUMENT_KIND, INVOICE_SUBJECT_TYPE,
} from "./billing/invoice-document.js";
export type { InvoiceDocumentInput, InvoiceDocumentDeps } from "./billing/invoice-document.js";

// ---- P6 — funnels as a lead source, and cost per lead per campaign ----
export {
  createFunnel, updateFunnel, setFunnelStatus, getFunnel, listFunnels, publishedFunnelBySlug, FunnelRefused,
  CreateFunnelInput, UpdateFunnelInput, SetFunnelStatusInput, ListFunnelsInput,
} from "./funnels/crud.js";
export type { FunnelRow } from "./funnels/crud.js";
export {
  FunnelStepSchema, FunnelStepsSchema, FunnelSuccessSchema, FunnelChoiceOptionSchema,
  contactStepIndex, maximumScore, defaultFunnelSteps,
} from "./funnels/steps.js";
export type { FunnelStepsInput } from "./funnels/steps.js";
export {
  answerFunnelStep, completeFunnelSession, sessionByToken,
  AnswerFunnelStepInput, CompleteFunnelSessionInput, FUNNEL_HOT_NOTIFICATION_KIND,
} from "./funnels/sessions.js";
export type { FunnelSessionRow, AnswerFunnelStepResult } from "./funnels/sessions.js";
export { funnelPerformance, recentFunnelSessions, FunnelPerformanceInput, RecentFunnelSessionsInput } from "./funnels/summary.js";
export type { FunnelPerformance } from "./funnels/summary.js";
export {
  ingestDailyCampaignMetrics, campaignSpend, AdCampaignIngestError,
  IngestCampaignMetricsInput, CampaignSpendInput,
} from "./ads/campaigns.js";
export type { CampaignIngestResult, CampaignSpend, CampaignSpendTotals } from "./ads/campaigns.js";
export { costPerLeadByCampaign, normaliseCampaign, CostPerLeadInput } from "./leads/cost-per-lead.js";
export type { CostPerLeadReport, CampaignCostPerLead } from "./leads/cost-per-lead.js";
