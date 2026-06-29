// ─────────────────────────────────────────────────────────────────────────────
// components/signal-indicator.tsx
//
// [STEP 4A] A small, reusable indicator showing a node's link status at a
// glance — now as TWO independent pieces, never merged into one ambiguous
// label:
//   - reachability  (online / stale / offline)  — purely "have we heard from
//     this node recently," driven by the colored dot + its label.
//   - signal quality (strong / good / weak / unknown) — purely "how good was
//     the last actual RSSI reading," driven by the bars + label + dBm value.
// A stale signal reading (older than SIGNAL_SAMPLE_STALE_MS) is shown muted
// with its age, instead of being presented as if it were current.
//
// PURE presentational component — it takes already-classified values as
// props and renders them. All the classification logic lives in fling-app.tsx
// (classifyReachability / classifySignalQuality), so this stays simple.
// ─────────────────────────────────────────────────────────────────────────────

import { SIGNAL_SAMPLE_STALE_MS } from "@/lib/constants";
import type { ReachabilityStatus, SignalQuality } from "@/lib/types";

interface SignalIndicatorProps {
  reachability?: ReachabilityStatus;
  signalQuality?: SignalQuality;
  rssi?: number;
  signalSampledAt?: Date;
  signalHopDistance?: number;
  // "dot"  → just a coloured reachability dot (for the avatar corner)
  // "full" → dot + label + signal bars + signal label (for a contact row / chat header)
  variant?: "dot" | "full";
  className?: string;
}

// Each reachability value → colour + human label.
const REACHABILITY_META: Record<
  ReachabilityStatus,
  { label: string; dot: string; text: string }
> = {
  online:  { label: "Online",  dot: "bg-emerald-500", text: "text-emerald-400" },
  stale:   { label: "Stale",   dot: "bg-amber-500",   text: "text-amber-400"   },
  offline: { label: "Offline", dot: "bg-red-500",     text: "text-red-400"     },
};

// Each signal-quality value → colour + human label.
const SIGNAL_META: Record<
  SignalQuality,
  { label: string; bar: string; text: string }
> = {
  strong:  { label: "Strong",         bar: "bg-emerald-500", text: "text-emerald-400" },
  good:    { label: "Good",           bar: "bg-blue-500",    text: "text-blue-400"    },
  weak:    { label: "Weak",           bar: "bg-amber-500",   text: "text-amber-400"   },
  unknown: { label: "Signal unknown", bar: "bg-gray-600",    text: "text-gray-500"    },
};

// Convert RSSI (dBm, negative) into 0–4 filled bars for the visual display.
// Purely cosmetic granularity — the actual strong/good/weak bucket uses the
// constants in lib/constants.ts via classifySignalQuality().
function rssiToBars(rssi?: number): number {
  if (rssi === undefined) return 0;
  if (rssi >= -70)  return 4;
  if (rssi >= -85)  return 3;
  if (rssi >= -100) return 2;
  if (rssi >= -115) return 1;
  return 0;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function SignalIndicator({
  reachability = "offline",
  signalQuality = "unknown",
  rssi,
  signalSampledAt,
  signalHopDistance,
  variant = "full",
  className = "",
}: SignalIndicatorProps) {
  const reachMeta = REACHABILITY_META[reachability] ?? REACHABILITY_META.offline;

  // Dot-only variant (avatar corner) — reachability ONLY. Pulses while online.
  if (variant === "dot") {
    return (
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full border-2 border-gray-800 ${reachMeta.dot} ${
          reachability === "online" ? "animate-pulse" : ""
        } ${className}`}
        aria-label={reachMeta.label}
      />
    );
  }

  // Full variant: reachability dot+label, then an independent signal segment.
  const sigMeta = SIGNAL_META[signalQuality] ?? SIGNAL_META.unknown;
  const bars = rssiToBars(rssi);
  const hasReading = signalQuality !== "unknown" && rssi !== undefined;

  const ageMs = signalSampledAt ? Date.now() - signalSampledAt.getTime() : undefined;
  const isStaleReading = ageMs !== undefined && ageMs > SIGNAL_SAMPLE_STALE_MS;

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {/* Reachability segment */}
      <span className="inline-flex items-center gap-1">
        <span className={`inline-block h-2 w-2 rounded-full ${reachMeta.dot}`} aria-hidden="true" />
        <span className={`text-xs font-medium ${reachMeta.text}`}>{reachMeta.label}</span>
      </span>

      <span className="text-gray-600" aria-hidden="true">·</span>

      {/* Signal-quality segment — visually muted when the reading is stale */}
      <span className={`inline-flex items-center gap-1.5 ${isStaleReading ? "opacity-50" : ""}`}>
        {hasReading && (
          <span className="inline-flex items-end gap-0.5 h-3" aria-hidden="true">
            {[1, 2, 3, 4].map((level) => (
              <span
                key={level}
                className={`w-0.5 rounded-sm ${level <= bars ? sigMeta.bar : "bg-gray-600"}`}
                style={{ height: `${level * 3}px` }}
              />
            ))}
          </span>
        )}
        <span className={`text-xs font-medium ${sigMeta.text}`}>{sigMeta.label}</span>
        {hasReading && (
          <span className="text-xs text-gray-500">
            {rssi} dBm
            {!!signalHopDistance && ` (via ${signalHopDistance}h)`}
            {isStaleReading && ageMs !== undefined && ` · ${formatAge(ageMs)} old`}
          </span>
        )}
      </span>
    </span>
  );
}
