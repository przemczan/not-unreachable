import { RECENT_UPLOADERS_LIMIT, RECENT_UPLOADS_DAYS, type Dashboard, type RecentUploader } from "@not-unreachable/contracts";
import type { AccountsService } from "../accounts/index.ts";
import type { AuditService } from "../audit/index.ts";
import type { InvitationsService } from "../invitations/index.ts";
import { DAY_MS, type Clock } from "../platform/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import type { ShareLinksService } from "../share-links/index.ts";

/** The admin Dashboard: each count is one aggregate query of the module that owns the table. */
export interface DashboardService {
  read(): Dashboard;
}

export interface DashboardServiceDependencies {
  readonly accounts: Pick<AccountsService, "countUsers" | "findById">;
  readonly audit: Pick<AuditService, "uploadersSince">;
  readonly invitations: Pick<InvitationsService, "countPending">;
  readonly resources: Pick<ResourcesService, "countByState">;
  readonly shareLinks: Pick<ShareLinksService, "counts">;
  readonly clock: Clock;
}

export function createDashboardService({
  accounts,
  audit,
  invitations,
  resources,
  shareLinks,
  clock,
}: DashboardServiceDependencies): DashboardService {
  /** The audit log keeps the uploader's account id; only accounts that are still users are listed. */
  const recentUploaders = (): RecentUploader[] => {
    const since = new Date(clock.now().getTime() - RECENT_UPLOADS_DAYS * DAY_MS);
    const uploaders: RecentUploader[] = [];
    for (const uploader of audit.uploadersSince(since)) {
      if (uploaders.length === RECENT_UPLOADERS_LIMIT) break;
      const account = accounts.findById(uploader.accountId);
      if (account?.role !== "user") continue;
      uploaders.push({
        userId: account.id,
        username: account.username,
        displayName: account.displayName,
        uploads: uploader.uploads,
        lastUploadAt: uploader.lastUploadAt,
      });
    }
    return uploaders;
  };

  return {
    read() {
      const users = accounts.countUsers();
      const resourceCounts = resources.countByState();
      const links = shareLinks.counts();
      return {
        users: { active: users.active, disabled: users.disabled },
        pendingInvitations: invitations.countPending(),
        resources: { available: resourceCounts.available, unavailable: resourceCounts.unavailable },
        shareLinks: {
          active: links.active,
          expired: links.expired,
          revoked: links.revoked,
          locked: links.locked,
          downloads: links.downloads,
        },
        recentUploaders: recentUploaders(),
      };
    },
  };
}
