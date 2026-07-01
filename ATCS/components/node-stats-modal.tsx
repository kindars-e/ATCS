// ─────────────────────────────────────────────────────────────────────────────
// components/node-stats-modal.tsx
//
// [STEP 8] Simplified diagnostics panel — shows only information meaningful
// to a field user or first-responder. Debug counters (pktSent, dropped*) that
// are only useful for protocol engineers have been hidden behind an expandable
// "Advanced" section so the primary view stays clean.
//
// Battery removed completely (no hardware to read it from).
// ─────────────────────────────────────────────────────────────────────────────

"use client";
import { useState } from "react";
import { Activity, ChevronDown, ChevronUp, Radio, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { NodeStats } from "@/lib/types";

interface NodeStatsModalProps {
  deviceId: string;
  deviceName: string;
  frequencyHz: number;
  spreadingFactor: number;
  bandwidthHz: number;
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

function Row({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-700/50 last:border-0">
      <span className="text-sm text-gray-400">{label}</span>
      <span className={`text-sm font-medium ${highlight ? "text-emerald-400" : "text-white"}`}>{value}</span>
    </div>
  );
}

export function NodeStatsModal({
  deviceId,
  deviceName,
  frequencyHz,
  spreadingFactor,
  bandwidthHz,
  stats,
  onClose,
}: NodeStatsModalProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-3xl p-6 max-w-md w-full shadow-2xl">
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Activity className="h-5 w-5 text-blue-400" />
            Node Status
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}
            className="rounded-full text-gray-400 hover:text-white hover:bg-gray-700">
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Radio config */}
        <div className="bg-gray-900/50 rounded-xl p-4 mb-3">
          <Row label="Node" value={`${deviceName} (${deviceId})`} />
          <Row label="Frequency" value={`${frequencyHz / 1_000_000} MHz`} />
          <Row label="Spreading Factor" value={`SF${spreadingFactor}`} />
          <Row label="Bandwidth" value={`${bandwidthHz / 1000} kHz`} />
        </div>

        {/* Live mesh health — primary view */}
        {stats ? (
          <>
            <div className="bg-gray-900/50 rounded-xl p-4 mb-3">
              <p className="text-xs text-gray-500 font-medium mb-2 flex items-center gap-1.5">
                <Radio className="h-3.5 w-3.5" /> Mesh health (updates every ~5s)
              </p>
              <Row label="Uptime" value={formatUptime(stats.uptime)} />
              <Row label="Connected phones" value={stats.connectedClients} highlight={stats.connectedClients > 0} />
              <Row label="Messages sent" value={stats.appMsgSent} />
              <Row label="Messages received" value={stats.messagesReceived} />
              <Row label="Packets relayed" value={stats.pktForwarded} />
              <Row label="Route discoveries" value={stats.routeDiscoveries} />
            </div>

            {/* Advanced / developer counters — collapsed by default */}
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between text-xs text-gray-500 hover:text-gray-300 px-1 mb-3 transition-colors"
            >
              <span>Advanced diagnostics</span>
              {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            {showAdvanced && (
              <div className="bg-gray-900/50 rounded-xl p-4 mb-3">
                <Row label="All LoRa packets sent" value={stats.pktSent} />
                <Row label="Dropped — duplicate" value={stats.pktDroppedDup} />
                <Row label="Dropped — no route" value={stats.pktDroppedNoRoute} />
                <Row label="Dropped — queue full" value={stats.pktDroppedQueueFull} />
              </div>
            )}
          </>
        ) : (
          <p className="text-gray-500 text-xs text-center py-4">
            Waiting for first diagnostics update…
          </p>
        )}
      </div>
    </div>
  );
}
