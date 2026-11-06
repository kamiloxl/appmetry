import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money, moneyCompact, number } from '../lib/format';
import type { Overview } from '../lib/types';
import { cn } from '../lib/utils';

const tick = { fill: '#8a837d', fontSize: 12 };

/**
 * Installs and trial starts as lines (left axis, counts) over revenue bars (right axis, USD).
 * X labels come straight from the server's series.
 */
export function Chart({ series, stale = false }: { series: Overview['series'] | null; stale?: boolean }) {
  return (
    <section className={cn('card flex flex-col transition-opacity', stale && 'opacity-60')} aria-label="Installs, trials and revenue chart">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Installs, trials &amp; revenue</h2>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-full bg-installsInk" aria-hidden="true" /> Installs
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-full bg-trials" aria-hidden="true" /> Trials
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-revenue" aria-hidden="true" /> Revenue
          </span>
        </div>
      </div>
      <div className="h-[300px] px-2 pb-3 pt-5 sm:px-3">
        {series ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#ece8e3" strokeDasharray="4 4" />
              <XAxis dataKey="label" tick={tick} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis yAxisId="i" tick={tick} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
              <YAxis
                yAxisId="r"
                orientation="right"
                tick={tick}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(v: number) => moneyCompact(v)}
                // Headroom keeps revenue bars in the lower part, under the installs line; the floor drops below 0 for refund bars.
                domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(1, Math.ceil(max * 1.6))]}
              />
              <Tooltip
                cursor={{ fill: 'rgba(28,25,23,0.04)' }}
                contentStyle={{ borderRadius: 10, border: '1px solid #e7e3de', boxShadow: '0 12px 32px -8px rgba(28,25,23,0.18)', fontSize: 13, padding: '8px 12px' }}
                labelStyle={{ color: '#1c1917', fontWeight: 600, marginBottom: 4 }}
                formatter={(v, name) => (name === 'Revenue' ? money(Number(v)) : number(Number(v)))}
              />
              <Bar yAxisId="r" dataKey="revenue" name="Revenue" fill="#e07b5f" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
              <Line yAxisId="i" type="monotone" dataKey="installs" name="Installs" stroke="#5a9be0" strokeWidth={2.5} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} isAnimationActive={false} />
              {/* Trials share the installs scale, so the line runs low across the revenue bars: a white halo keeps it readable. */}
              <Line yAxisId="i" type="monotone" dataKey="trials" stroke="#ffffff" strokeWidth={6} dot={false} activeDot={false} legendType="none" tooltipType="none" isAnimationActive={false} />
              <Line yAxisId="i" type="monotone" dataKey="trials" name="Trials" stroke="#8e6bd8" strokeWidth={2.5} dot={{ r: 2.5, strokeWidth: 0, fill: '#8e6bd8' }} activeDot={{ r: 4, strokeWidth: 0 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full animate-pulse rounded-lg bg-muted" />
        )}
      </div>
    </section>
  );
}
