import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money, moneyCompact, number } from '../lib/format';
import type { Overview } from '../lib/types';

const tick = { fill: '#a8a29e', fontSize: 12 };

/** Installs as a line (left axis) over revenue bars (right axis, USD). X labels come straight from the server's series. */
export function Chart({ series, stale = false }: { series: Overview['series'] | null; stale?: boolean }) {
  return (
    <div className={`card h-[340px] px-2 pb-3 pt-6 sm:px-4 ${stale ? 'opacity-60' : ''}`} aria-label="Installs and revenue chart">
      {series ? (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#efedea" strokeDasharray="4 4" />
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
            <Tooltip formatter={(v, name) => (name === 'Revenue' ? money(Number(v)) : number(Number(v)))} />
            <Legend iconType="circle" />
            <Bar yAxisId="r" dataKey="revenue" name="Revenue" fill="#e07b5f" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
            <Line yAxisId="i" type="monotone" dataKey="installs" name="Installs" stroke="#5a9be0" strokeWidth={2.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-full animate-pulse rounded-xl bg-stone-50" />
      )}
    </div>
  );
}
