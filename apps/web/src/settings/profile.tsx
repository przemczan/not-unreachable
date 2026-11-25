import { displayNameSchema, emailSchema, type Profile, type Session } from "@not-unreachable/contracts";
import { Alert, Button, Card, Input, useToast } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { SettingsRow } from "../layout/index.ts";
import { errorProp, problemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, sessionQueryKey, useRecentSignIn } from "../session/index.ts";

const profileQueryKey = ["settings", "profile"] as const;

export function ProfileSettings() {
  const query = useQuery({ queryKey: profileQueryKey, queryFn: ({ signal }) => api("getProfile", { signal }) });
  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading your profile…</p>;
  if (query.isError)
    return <Alert tone="danger">{problemMessage(query.error, "Your profile could not be loaded. Reload the page to try again.")}</Alert>;
  return <ProfileForm profile={query.data} />;
}

interface FieldErrors {
  displayName?: string;
  email?: string;
}

function ProfileForm({ profile }: { readonly profile: Profile }) {
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [displayName, setDisplayName] = useState(profile.displayName);
  // A user may have no email yet: the field starts empty, and stays out of the change until one is typed.
  const savedEmail = profile.email ?? "";
  const [email, setEmail] = useState(savedEmail);
  const [errors, setErrors] = useState<FieldErrors>({});

  const change = { displayName: displayName.trim(), email: email.trim() };
  const changed = change.displayName !== profile.displayName || change.email !== savedEmail;

  const save = useMutation({
    // Only the fields that changed: a new email needs a recent sign-in, a new name doesn't.
    mutationFn: () =>
      run(() =>
        api("updateProfile", {
          body: {
            ...(change.displayName === profile.displayName ? {} : { displayName: change.displayName }),
            ...(change.email === savedEmail ? {} : { email: change.email }),
          },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(profileQueryKey, updated);
      queryClient.setQueryData<Session | null>(sessionQueryKey, (session) =>
        session == null ? session : { ...session, account: updated },
      );
      setDisplayName(updated.displayName);
      setEmail(updated.email ?? "");
      toast.show({ tone: "success", title: "Profile saved" });
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FieldErrors = {};
    if (!displayNameSchema.safeParse(change.displayName).success) found.displayName = "Enter a name of up to 100 characters.";
    const emailLeftEmpty = change.email === "" && profile.email === null;
    if (!emailLeftEmpty && !emailSchema.safeParse(change.email).success) found.email = "Enter an email address, such as name@example.com.";
    setErrors(found);
    if (found.displayName === undefined && found.email === undefined && changed) save.mutate();
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {save.isError && !isRecentSignInCancelled(save.error) && (
        <Alert tone="danger">{problemMessage(save.error, "Saving did not work. Try again.")}</Alert>
      )}
      <Card title="Profile" padding="none" bodyClassName="px-5">
        <SettingsRow label="Username" htmlFor={`${id}-username`} description="It names your home folder, so it can't be changed.">
          <Input id={`${id}-username`} value={profile.username} readOnly />
        </SettingsRow>
        <SettingsRow label="Display name" htmlFor={`${id}-display-name`} description="Shown in the app and in the audit log.">
          <Input
            id={`${id}-display-name`}
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            {...errorProp(errors.displayName)}
          />
        </SettingsRow>
        <SettingsRow label="Email" htmlFor={`${id}-email`} description="Changing it may ask you to confirm it's you.">
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...errorProp(errors.email)}
          />
        </SettingsRow>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" disabled={!changed} loading={save.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
