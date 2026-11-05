import { Area, Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { duration, money, moneyCompact, number, pct } from '../lib/format';
import type { Overview, Totals } from '../lib/types';

/** Relative change of `cur` against `prev`; null when there is no previous value to compare with. */
function change(cur: number, prev: number): number | null {
  return prev ? (cur - prev) / prev : null;
}

function Change({ cur, prev }: { cur: number; prev: number }) {
  const c = change(cur, prev);
  if (c === null) return <span className="text-xs text-stone-400">{pct(null)}</span>;
  return <span className={`text-xs ${c >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{pct(c)}</span>;
}

const KPIS: { key: keyof Totals; label: string; format: (v: number) => string; dot?: string }[] = [
  { key: 'installs', label: 'Installs', format: number, dot: 'bg-installs' },
  { key: 'revenue', label: 'Revenue', format: moneyCompact, dot: 'bg-revenue' },
  { key: 'conversionRate', label: 'Conversion', format: (v) => `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%` },
  { key: 'revenuePerInstall', label: 'Revenue/install', format: money },
  { key: 'activeUsers', label: 'Active users', format: number },
  { key: 'avgSessionMs', label: 'Session time', format: duration },
];

/** KPI strip and the installs/revenue chart of the Overview page. */
export function OverviewCard({ data }: { data: Overview | null }) {
  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-2 border-b border-stone-100 sm:grid-cols-3 lg:grid-cols-6">
        {data ? (
          KPIS.map((k) => (
            <div key={k.key} className="border-stone-100 px-5 py-4 lg:border-r">
              <div className="flex items-center gap-1.5 text-sm text-stone-500">
                {k.dot && <span className={`h-2.5 w-2.5 rounded-sm ${k.dot}`} />}
                {k.label}
              </div>
              <div className="mt-1 text-[26px] font-semibold leading-tight tracking-tight">{k.format(data.current[k.key])}</div>
              <Change cur={data.current[k.key]} prev={data.previous[k.key]} />
            </div>
          ))
        ) : (
          <div className="col-span-full h-[98px] animate-pulse bg-stone-50" />
        )}
      </div>
      <div className="h-[340px] px-2 pb-3 pt-6 sm:px-4">
        {data && (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data.series} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#efedea" strokeDasharray="4 4" />
              <XAxis dataKey="label" tick={{ fill: '#a8a29e', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis yAxisId="i" tick={{ fill: '#a8a29e', fontSize: 12 }} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
              <YAxis
                yAxisId="r"
                orientation="right"
                tick={{ fill: '#a8a29e', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(v: number) => moneyCompact(v)}
                // Headroom keeps revenue bars in the lower part of the chart, under the installs line.
                domain={[0, (max: number) => Math.max(1, Math.ceil(max * 1.6))]}
              />
              <Tooltip formatter={(v, name) => (name === 'revenue' ? money(Number(v)) : number(Number(v)))} />
              <Bar yAxisId="r" dataKey="revenue" fill="#e07b5f" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
              <Area yAxisId="i" type="monotone" dataKey="installs" stroke="#7cb1ea" strokeWidth={2.5} fill="#8dbdf0" fillOpacity={0.25} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
