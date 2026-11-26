import type { Dashboard } from "@not-unreachable/contracts";
import type { AccountsService } from "../accounts/index.ts";
import type { InvitationsService } from "../invitations/index.ts";
import type { ResourcesService } from "../resources/index.ts";
import type { ShareLinksService } from "../share-links/index.ts";

/** The admin Dashboard: each count is one aggregate query of the module that owns the table. */
export interface DashboardService {
  read(): Dashboard;
}

export interface DashboardServiceDependencies {
  readonly accounts: Pick<AccountsService, "countUsers">;
  readonly invitations: Pick<InvitationsService, "countPending">;
  readonly resources: Pick<ResourcesService, "countByState">;
  readonly shareLinks: Pick<ShareLinksService, "counts">;
}

export function createDashboardService({ accounts, invitations, resources, shareLinks }: DashboardServiceDependencies): DashboardService {
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
      };
    },
  };
}
