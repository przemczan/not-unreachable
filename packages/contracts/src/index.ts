import {
  changePasswordRoute,
  getProfileRoute,
  listSessionsRoute,
  revokeOtherSessionsRoute,
  revokeSessionRoute,
  updateProfileRoute,
} from "./account-settings.ts";
import { exportAuditEventsRoute, listAuditEventsRoute } from "./audit-events.ts";
import {
  createHomeFolderRoute,
  createResourceFolderRoute,
  deleteHomeEntryRoute,
  deleteResourceEntryRoute,
  downloadHomeFileRoute,
  downloadResourceFileRoute,
  getHomeQuotaRoute,
  listHomeEntriesRoute,
  listResourceEntriesRoute,
} from "./files.ts";
import { healthRoute } from "./health.ts";
import {
  acceptInvitationRoute,
  createInvitationRoute,
  getInvitationLinkRoute,
  getInvitationRoute,
  getRelinkRoute,
  listInvitationsRoute,
  resendInvitationRoute,
  revokeInvitationRoute,
  startRelinkRoute,
} from "./invitations.ts";
import { getMailSettingsRoute, sendTestEmailRoute, updateMailSettingsRoute } from "./mail.ts";
import {
  addPasskeyRoute,
  confirmPasskeyEnrolmentRoute,
  listPasskeysRoute,
  passkeySignInRoute,
  passPasskeyRoute,
  removePasskeyRoute,
  renamePasskeyRoute,
  startPasskeyConfirmationRoute,
  startPasskeyEnrolmentRoute,
  startPasskeyRegistrationRoute,
  startPasskeySecondFactorRoute,
  startPasskeySignInRoute,
} from "./passkeys.ts";
import type { RouteTable } from "./route.ts";
import {
  addResourceRoute,
  allowFolderRoute,
  changeResourceRoute,
  checkResourceRoute,
  getResourceRoute,
  listResourcesRoute,
  removeResourceRoute,
  retryResourceRoute,
  setHomeRootRoute,
} from "./resources.ts";
import {
  acknowledgeRecoveryCodesRoute,
  addTotpRoute,
  confirmTotpEnrolmentRoute,
  confirmTotpRoute,
  getSecondFactorsRoute,
  getSecondFactorStepRoute,
  passRecoveryCodeRoute,
  passTotpRoute,
  regenerateRecoveryCodesRoute,
  removeTotpRoute,
  startTotpEnrolmentRoute,
} from "./second-factors.ts";
import { getSecuritySettingsRoute, updateSecuritySettingsRoute } from "./security-settings.ts";
import { confirmSessionRoute, getSessionRoute, signInRoute, signOutRoute } from "./session.ts";
import { setupRoute, setupStatusRoute } from "./setup.ts";
import {
  addSsoProviderRoute,
  changeSsoProviderRoute,
  listLinkedSignInsRoute,
  listSignInProvidersRoute,
  listSsoProvidersRoute,
  removeSsoProviderRoute,
  ssoCallbackRoute,
  startLinkRoute,
  startSsoSignInRoute,
  unlinkRoute,
} from "./sso.ts";
import { getUploadLimitsRoute, updateUploadLimitsRoute } from "./upload-limits.ts";
import {
  changeShareLinkRoute,
  createShareLinkRoute,
  downloadShareLinkContentRoute,
  getPublicShareLinkRoute,
  getShareLinkRoute,
  listShareLinkEntriesRoute,
  listSharedWithMeRoute,
  listShareLinksRoute,
  revokeShareLinkRoute,
  unlockShareLinkRoute,
} from "./share-links.ts";
import { checkForUpdatesRoute, getUpdatesRoute, installUpdateRoute } from "./updates.ts";
import { cancelUploadRoute, createUploadRoute, getUploadOffsetRoute, sendUploadChunkRoute } from "./uploads.ts";
import {
  changeUserRoute,
  createRelinkLinkRoute,
  getUserRoute,
  listUsersRoute,
  removeUserLinkedSignInRoute,
  removeUserRoute,
  setDefaultQuotaRoute,
} from "./users.ts";

export * from "./route.ts";
export * from "./problem.ts";
export * from "./health.ts";
export * from "./accounts.ts";
export * from "./setup.ts";
export * from "./session.ts";
export * from "./account-settings.ts";
export * from "./second-factors.ts";
export * from "./webauthn.ts";
export * from "./passkeys.ts";
export * from "./audit-events.ts";
export * from "./security-settings.ts";
export * from "./resources.ts";
export * from "./sso.ts";
export * from "./invitations.ts";
export * from "./users.ts";
export * from "./mail.ts";
export * from "./files.ts";
export * from "./uploads.ts";
export * from "./upload-limits.ts";
export * from "./share-links.ts";
export * from "./updates.ts";

/** Every route of the API. The server registers only these, and the web client calls them by name. */
export const routes = {
  health: healthRoute,
  setupStatus: setupStatusRoute,
  setup: setupRoute,
  signIn: signInRoute,
  signOut: signOutRoute,
  getSession: getSessionRoute,
  confirmSession: confirmSessionRoute,
  startPasskeyConfirmation: startPasskeyConfirmationRoute,
  startPasskeySignIn: startPasskeySignInRoute,
  passkeySignIn: passkeySignInRoute,
  getSecondFactorStep: getSecondFactorStepRoute,
  passTotp: passTotpRoute,
  passRecoveryCode: passRecoveryCodeRoute,
  startPasskeySecondFactor: startPasskeySecondFactorRoute,
  passPasskey: passPasskeyRoute,
  startTotpEnrolment: startTotpEnrolmentRoute,
  confirmTotpEnrolment: confirmTotpEnrolmentRoute,
  startPasskeyEnrolment: startPasskeyEnrolmentRoute,
  confirmPasskeyEnrolment: confirmPasskeyEnrolmentRoute,
  acknowledgeRecoveryCodes: acknowledgeRecoveryCodesRoute,
  getProfile: getProfileRoute,
  updateProfile: updateProfileRoute,
  changePassword: changePasswordRoute,
  listSessions: listSessionsRoute,
  revokeSession: revokeSessionRoute,
  revokeOtherSessions: revokeOtherSessionsRoute,
  getSecondFactors: getSecondFactorsRoute,
  addTotp: addTotpRoute,
  confirmTotp: confirmTotpRoute,
  removeTotp: removeTotpRoute,
  regenerateRecoveryCodes: regenerateRecoveryCodesRoute,
  listPasskeys: listPasskeysRoute,
  startPasskeyRegistration: startPasskeyRegistrationRoute,
  addPasskey: addPasskeyRoute,
  renamePasskey: renamePasskeyRoute,
  removePasskey: removePasskeyRoute,
  listAuditEvents: listAuditEventsRoute,
  exportAuditEvents: exportAuditEventsRoute,
  getSecuritySettings: getSecuritySettingsRoute,
  updateSecuritySettings: updateSecuritySettingsRoute,
  listResources: listResourcesRoute,
  addResource: addResourceRoute,
  getResource: getResourceRoute,
  changeResource: changeResourceRoute,
  removeResource: removeResourceRoute,
  retryResource: retryResourceRoute,
  checkResource: checkResourceRoute,
  setHomeRoot: setHomeRootRoute,
  allowFolder: allowFolderRoute,
  listSsoProviders: listSsoProvidersRoute,
  addSsoProvider: addSsoProviderRoute,
  changeSsoProvider: changeSsoProviderRoute,
  removeSsoProvider: removeSsoProviderRoute,
  listSignInProviders: listSignInProvidersRoute,
  startSsoSignIn: startSsoSignInRoute,
  ssoCallback: ssoCallbackRoute,
  listLinkedSignIns: listLinkedSignInsRoute,
  startLink: startLinkRoute,
  unlink: unlinkRoute,
  listInvitations: listInvitationsRoute,
  createInvitation: createInvitationRoute,
  getInvitationLink: getInvitationLinkRoute,
  resendInvitation: resendInvitationRoute,
  revokeInvitation: revokeInvitationRoute,
  getInvitation: getInvitationRoute,
  acceptInvitation: acceptInvitationRoute,
  getRelink: getRelinkRoute,
  startRelink: startRelinkRoute,
  listUsers: listUsersRoute,
  getUser: getUserRoute,
  changeUser: changeUserRoute,
  removeUser: removeUserRoute,
  removeUserLinkedSignIn: removeUserLinkedSignInRoute,
  createRelinkLink: createRelinkLinkRoute,
  setDefaultQuota: setDefaultQuotaRoute,
  getMailSettings: getMailSettingsRoute,
  updateMailSettings: updateMailSettingsRoute,
  sendTestEmail: sendTestEmailRoute,
  listResourceEntries: listResourceEntriesRoute,
  createResourceFolder: createResourceFolderRoute,
  downloadResourceFile: downloadResourceFileRoute,
  deleteResourceEntry: deleteResourceEntryRoute,
  listHomeEntries: listHomeEntriesRoute,
  createHomeFolder: createHomeFolderRoute,
  downloadHomeFile: downloadHomeFileRoute,
  deleteHomeEntry: deleteHomeEntryRoute,
  getHomeQuota: getHomeQuotaRoute,
  createUpload: createUploadRoute,
  getUploadOffset: getUploadOffsetRoute,
  sendUploadChunk: sendUploadChunkRoute,
  cancelUpload: cancelUploadRoute,
  getUploadLimits: getUploadLimitsRoute,
  updateUploadLimits: updateUploadLimitsRoute,
  createShareLink: createShareLinkRoute,
  listShareLinks: listShareLinksRoute,
  getShareLink: getShareLinkRoute,
  changeShareLink: changeShareLinkRoute,
  revokeShareLink: revokeShareLinkRoute,
  listSharedWithMe: listSharedWithMeRoute,
  getPublicShareLink: getPublicShareLinkRoute,
  unlockShareLink: unlockShareLinkRoute,
  listShareLinkEntries: listShareLinkEntriesRoute,
  downloadShareLinkContent: downloadShareLinkContentRoute,
  getUpdates: getUpdatesRoute,
  checkForUpdates: checkForUpdatesRoute,
  installUpdate: installUpdateRoute,
} as const satisfies RouteTable;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
