// ─────────────────────────────────────────────────────────────────────────────
// components/node-stats-modal.tsx
//
// [STEP 4B] Lightweight read-only panel surfacing the connected node's own
// firmware diagnostics (the periodic "stats" WS frame) and battery level —
// previously only visible via the Arduino Serial Monitor. Purely
// informational; no controls, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

import { Activity, BatteryMedium, Radio, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { NodeStats } from "@/lib/types";

interface NodeStatsModalProps {
  deviceId: string;
  deviceName: string;
  frequencyHz: number;
  spreadingFactor: number;
  bandwidthHz: number;
  battery?: number;
  stats: NodeStats | null;
  onClose: () => void;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-700/50 last:border-0">
      <span className="text-sm text-gray-400">{label}</span>
      <span className="text-sm text-white font-medium">{value}</span>
    </div>
  );
}

export function NodeStatsModal({
  deviceId,
  deviceName,
  frequencyHz,
  spreadingFactor,
  bandwidthHz,
  battery,
  stats,
  onClose,
}: NodeStatsModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-3xl p-6 max-w-md w-full shadow-2xl">
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Activity className="h-5 w-5 text-blue-400" />
            Node Diagnostics
          </h2>
          <Button
            variant="ghost" size="icon"
            onClick={onClose}
            className="rounded-full text-gray-400 hover:text-white hover:bg-gray-700"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="bg-gray-900/50 rounded-xl p-4 mb-4">
          <Row label="Node" value={`${deviceName} (${deviceId})`} />
          <Row label="Frequency" value={`${frequencyHz / 1_000_000} MHz`} />
          <Row label="Spreading factor" value={`SF${spreadingFactor}`} />
          <Row label="Bandwidth" value={`${bandwidthHz / 1000} kHz`} />
          <Row
            label="Battery"
            value={battery !== undefined ? `${battery}%` : "Unknown"}
          />
        </div>

        {stats ? (
          <div className="bg-gray-900/50 rounded-xl p-4">
            <p className="text-xs text-gray-500 font-medium mb-2 flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5" /> Mesh diagnostics (live, updates every ~5s)
            </p>
            <Row label="Uptime" value={formatUptime(stats.uptime)} />
            {/* [STEP 7] "Messages sent" was renamed to "All packets sent (LoRa)"
                because the old counter included every HELLO beacon, ACK, RREQ,
                and relay forward — not just user-sent chat messages. The real
                user-message count is now tracked separately as appMsgSent. */}
            <Row label="User messages sent" value={stats.appMsgSent} />
            <Row label="All LoRa packets sent" value={stats.pktSent} />
            <Row label="Data messages received" value={stats.messagesReceived} />
            <Row label="Connected phones" value={stats.connectedClients} />
            <Row label="Packets forwarded (relay)" value={stats.pktForwarded} />
            <Row label="Dropped — duplicate" value={stats.pktDroppedDup} />
            <Row label="Dropped — no route" value={stats.pktDroppedNoRoute} />
            <Row label="Dropped — queue full" value={stats.pktDroppedQueueFull} />
            <Row label="Route discoveries" value={stats.routeDiscoveries} />
          </div>
        ) : (
          <p className="text-gray-500 text-xs text-center py-4">
            Waiting for the node's first diagnostics update…
          </p>
        )}

        <p className="text-gray-600 text-xs mt-4 leading-relaxed flex items-center gap-1.5">
          <BatteryMedium className="h-3.5 w-3.5 flex-shrink-0" />
          Battery is a fixed 100% on dev boards with no fuel gauge wired —
          the readout is real once real battery hardware is added.
        </p>
      </div>
    </div>
  );
}
