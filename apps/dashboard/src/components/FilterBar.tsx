import { ListFilter, X } from 'lucide-react';

const DIM_LABELS: Record<string, string> = {
  channel: 'Channel',
  source: 'Source',
  campaign: 'Campaign',
  asa_campaign_id: 'Search Ads campaign',
  platform: 'Platform',
  country: 'Country',
  app_version: 'App version',
  os_version: 'OS',
  device_model: 'Device',
};

/** Active filters as removable chips. With `hint`, an empty bar says how to add one; otherwise it renders nothing. */
export function FilterBar({ filters, onRemove, hint }: { filters: Record<string, string>; onRemove: (dim: string) => void; hint?: string }) {
  const entries = Object.entries(filters);
  if (entries.length === 0) {
    return hint ? (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ListFilter className="size-4" aria-hidden="true" />
        {hint}
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
      {entries.map(([dim, value]) => (
        <span key={dim} className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card pl-2.5 pr-1 text-sm shadow-card" data-testid={`chip-${dim}`}>
          <span className="text-muted-foreground">{DIM_LABELS[dim] ?? dim}</span>
          <span className="font-medium">{value}</span>
          <button
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => onRemove(dim)}
            aria-label={`Remove ${DIM_LABELS[dim] ?? dim} filter ${value}`}
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
