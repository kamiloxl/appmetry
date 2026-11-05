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

/** Active filters as removable chips. Renders nothing when there are none. */
export function FilterBar({ filters, onRemove }: { filters: Record<string, string>; onRemove: (dim: string) => void }) {
  const entries = Object.entries(filters);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
      {entries.map(([dim, value]) => (
        <span key={dim} className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white py-1 pl-3 pr-1.5 text-sm shadow-card" data-testid={`chip-${dim}`}>
          <span className="text-stone-500">{DIM_LABELS[dim] ?? dim}:</span>
          <span className="font-medium">{value}</span>
          <button className="flex h-5 w-5 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-ink" onClick={() => onRemove(dim)} aria-label={`Remove ${DIM_LABELS[dim] ?? dim} filter ${value}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
