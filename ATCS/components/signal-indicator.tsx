// ─────────────────────────────────────────────────────────────────────────────
// components/signal-indicator.tsx
//
// [v6 RANGE DETECTION] A small, reusable indicator showing a node's link status
// at a glance: a coloured status dot/label, optional signal bars derived from
// RSSI, and the RSSI value. Matches the app's dark Tailwind style
// (emerald = good, amber = weak, red/gray = lost).
//
// PURE presentational component — it takes a status + readings as props and
// renders them. All the logic that DECIDES the status lives in fling-app
// (classifyStatus / the range monitor), so this stays simple and reusable.
// ─────────────────────────────────────────────────────────────────────────────

import type { RangeStatus } from "@/lib/types";

interface SignalIndicatorProps {
  status?: RangeStatus;
  rssi?: number;
  // "dot"  → just a coloured status dot (for the avatar corner)
  // "full" → dot + label + signal bars (for a contact row / chat header)
  variant?: "dot" | "full";
  className?: string;
}

// Each status → colour + human label. Centralised so every place that shows a
// status uses identical wording and colours.
const STATUS_META: Record<
  RangeStatus,
  { label: string; dot: string; text: string }
> = {
  online:         { label: "Online",       dot: "bg-emerald-500", text: "text-emerald-400" },
  weak:           { label: "Weak signal",  dot: "bg-amber-500",   text: "text-amber-400"   },
  "out-of-range": { label: "Out of range", dot: "bg-red-500",     text: "text-red-400"     },
  offline:        { label: "Offline",      dot: "bg-gray-500",    text: "text-gray-400"    },
  away:           { label: "Away",         dot: "bg-gray-500",    text: "text-gray-400"    },
};

// Convert RSSI (dBm, negative) into 0–4 filled bars. Simple display thresholds;
// the real status decision uses the constants in lib/constants.ts.
function rssiToBars(rssi?: number): number {
  if (rssi === undefined) return 0;
  if (rssi >= -70)  return 4;   // strong
  if (rssi >= -85)  return 3;
  if (rssi >= -100) return 2;
  if (rssi >= -115) return 1;
  return 0;
}

export function SignalIndicator({
  status = "offline",
  rssi,
  variant = "full",
  className = "",
}: SignalIndicatorProps) {
  const meta = STATUS_META[status] ?? STATUS_META.offline;

  // Dot-only variant (used on the avatar corner). Pulses while online.
  if (variant === "dot") {
    return (
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full border-2 border-gray-800 ${meta.dot} ${
          status === "online" ? "animate-pulse" : ""
        } ${className}`}
        aria-label={meta.label}
      />
    );
  }

  // Full variant: signal bars + coloured label + RSSI value.
  const bars = rssiToBars(rssi);
  const showBars = status === "online" || status === "weak"; // no bars when lost

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {showBars && (
        <span className="inline-flex items-end gap-0.5 h-3" aria-hidden="true">
          {[1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className={`w-0.5 rounded-sm ${level <= bars ? meta.dot : "bg-gray-600"}`}
              style={{ height: `${level * 3}px` }}
            />
          ))}
        </span>
      )}
      <span className={`text-xs font-medium ${meta.text}`}>{meta.label}</span>
      {rssi !== undefined && showBars && (
        <span className="text-xs text-gray-500">{rssi} dBm</span>
      )}
    </span>
  );
}
