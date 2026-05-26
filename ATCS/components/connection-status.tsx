import { RefreshCw } from "lucide-react";

import type { ConnectionState } from "@/lib/types";

interface ConnectionStatusProps {
  connectionState: ConnectionState;
  reconnectAttempts: number;
  onReconnect: () => void;
}

const STATUS_COLORS: Record<ConnectionState, string> = {
  connected: "bg-green-500",
  connecting: "bg-yellow-500 animate-pulse",
  reconnecting: "bg-orange-500 animate-pulse",
  error: "bg-red-500",
  disconnected: "bg-gray-500",
};

export function ConnectionStatus({
  connectionState,
  reconnectAttempts,
  onReconnect,
}: ConnectionStatusProps) {
  const label = (() => {
    switch (connectionState) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting...";
      case "reconnecting":
        return `Reconnecting (${reconnectAttempts}/10)...`;
      case "error":
        return "Connection Error";
      default:
        return "Disconnected";
    }
  })();

  const showRetry =
    connectionState === "error" || connectionState === "disconnected";

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[connectionState]}`} />
      <span className="text-gray-300 text-sm">{label}</span>
      {showRetry && (
        <button
          onClick={onReconnect}
          className="p-1 rounded hover:bg-gray-700 transition-colors"
        >
          <RefreshCw className="h-3 w-3 text-gray-400" />
        </button>
      )}
    </div>
  );
}
