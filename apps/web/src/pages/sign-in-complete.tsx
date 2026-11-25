import { SSO_SIGN_IN_FAILED_PATH } from "@not-unreachable/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { forgetPendingNext, readPendingNext, safeNextPath, secondFactorPathWith, sessionQuery } from "../session/index.ts";

/**
 * Where a single sign-on lands (`/sign-in/complete`): it asks the server for the session the
 * callback made, and goes on to the second-factor step or to the sign-in page's `?next=`, kept
 * before the provider's page, if it is safe, else the role's landing page. Without a session the
 * sign-in failed, with the one neutral message.
 */
export function Component() {
  // Always asked afresh: a session cached before the provider's page says nothing about this one.
  const { data: session, isFetching, isError, error } = useQuery({ ...sessionQuery, refetchOnMount: "always" });
  const [next] = useState(readPendingNext);
  // Used once, whichever way this sign-in went.
  useEffect(() => forgetPendingNext(), []);
  if (isFetching) return null;
  if (isError) throw error;
  if (session == null) return <Navigate replace to={SSO_SIGN_IN_FAILED_PATH} />;
  // The second-factor step checks `next` itself once it is passed.
  if (session.state === "pendingSecondFactor") return <Navigate replace to={secondFactorPathWith(next)} />;
  return <Navigate replace to={safeNextPath(next, session.account.role)} />;
}
