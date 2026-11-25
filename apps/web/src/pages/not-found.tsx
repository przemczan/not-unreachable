import { PageHeader, PublicLayout } from "@not-unreachable/design-system";

export function NotFound() {
  return (
    <PublicLayout>
      <PageHeader title="Page not found" description="There is nothing at this address." />
    </PublicLayout>
  );
}
