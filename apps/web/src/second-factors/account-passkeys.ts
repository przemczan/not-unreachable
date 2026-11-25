import { useQuery } from "@tanstack/react-query";
import { api } from "../api/index.ts";
import { passkeysQueryKey, passkeysSupported } from "./passkey-ceremony.ts";

/**
 * Whether the signed-in account can confirm with one of its passkeys: the browser can use passkeys
 * and the account has one. Lists the passkeys only while `enabled`, such as while a dialog is open.
 */
export function useCanConfirmWithPasskey(enabled: boolean): boolean {
  const supported = passkeysSupported();
  const passkeys = useQuery({
    queryKey: passkeysQueryKey,
    queryFn: ({ signal }) => api("listPasskeys", { signal }),
    enabled: enabled && supported,
  });
  return supported && (passkeys.data?.passkeys.length ?? 0) > 0;
}
