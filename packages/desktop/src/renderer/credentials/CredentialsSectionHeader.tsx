import type { ReactNode } from "react";

export function CredentialsSectionHeader({
  title,
  description,
  stats,
  badge,
}: {
  title: string;
  description: string;
  stats: readonly { label: string; value: ReactNode }[];
  badge?: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-2" data-credential-section-header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        {badge}
      </div>
      <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs leading-5 text-muted-foreground">
        {stats.map(({ label, value }) => (
          <li key={label} className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5">
            <span className="font-medium tabular-nums text-foreground">{value}</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
