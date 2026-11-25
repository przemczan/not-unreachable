/*
 * The sign-in page's `?next=` while a single sign-on is away at the provider, whose callback lands
 * on /sign-in/complete without it. Kept in this tab only, and used once; whoever reads it checks it
 * with safeNextPath again, as anything in storage may have been changed.
 */
const pendingNextKey = "sign-in-next";

/** Keeps `next` for /sign-in/complete; without one, forgets an older one. */
export function savePendingNext(next: string | null): void {
  try {
    if (next === null || next === "") sessionStorage.removeItem(pendingNextKey);
    else sessionStorage.setItem(pendingNextKey, next);
  } catch {
    // Storage is refused (private mode, quota): the sign-in goes to the landing page instead.
  }
}

/**
 * The `next` kept before the provider's page, if any. Read during render, which React may repeat,
 * so forgetting it is a step of its own: forgetPendingNext, once it is used.
 */
export function readPendingNext(): string | null {
  try {
    return sessionStorage.getItem(pendingNextKey);
  } catch {
    return null;
  }
}

export function forgetPendingNext(): void {
  try {
    sessionStorage.removeItem(pendingNextKey);
  } catch {
    // Nothing was kept, then.
  }
}
