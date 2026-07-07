import {
  Activity,
  Navigation,
  Radio,
  RefreshCw,
  Shield,
  Signal,
  Sparkles,
  Trash2,
  UserPlus,
  Zap,
} from "lucide-react";
import { useRef } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConnectionStatus } from "@/components/connection-status";
import { FlingLogo } from "@/components/fling-logo";
import { SignalIndicator } from "@/components/signal-indicator";
import { RADIO_FREQUENCY_HZ } from "@/lib/constants";
import type { Contact, ConnectionState } from "@/lib/types";

interface PwaInstallHandle {
  canInstall: boolean;
  install: () => void;
  dismiss: () => void;
}

interface ContactsViewProps {
  contacts: Contact[];
  pwaInstall: PwaInstallHandle;
  connectionState: ConnectionState;
  reconnectAttempts: number;
  lastConnectionError: string | null;
  onShowNodeStats: () => void;
  showDeleteMenu: string | null;
  onToggleDeleteMenu: (deviceId: string | null) => void;
  onShowWaypoints: () => void;
  onShowAddContact: () => void;
  onOpenChat: (contact: Contact) => void;
  onDeleteContact: (deviceId: string) => void;
  onReconnect: () => void;
}

export function ContactsView({
  contacts,
  pwaInstall,
  connectionState,
  reconnectAttempts,
  lastConnectionError,
  onShowNodeStats,
  showDeleteMenu,
  onToggleDeleteMenu,
  onShowWaypoints,
  onShowAddContact,
  onOpenChat,
  onDeleteContact,
  onReconnect,
}: ContactsViewProps) {
  // Long-press support for touch devices
  const longPressTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleTouchStart = (deviceId: string) => {
    longPressTimers.current[deviceId] = setTimeout(() => {
      onToggleDeleteMenu(deviceId);
    }, 600);
  };

  const handleTouchEnd = (deviceId: string) => {
    clearTimeout(longPressTimers.current[deviceId]);
  };

  return (
    <div className="app-container flex flex-col bg-gray-900">
      <div className="bg-gray-900 border-b border-gray-800">
        <div className="px-4 pt-12 pb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-12 h-12 flex items-center justify-center">
                  <FlingLogo className="w-10 h-10 text-white" />
                </div>
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white tracking-tight">ATCS</h1>
                <p className="text-sm text-gray-500 mt-0.5">Communication beyond network coverage</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={onShowWaypoints}
                className="relative p-3 rounded-xl hover:bg-gray-800 transition-colors group"
              >
                <Navigation className="h-5 w-5 text-gray-400 group-hover:text-white transition-colors" />
              </button>
              {/* [REMOVED] Settings button — it had no onClick handler and did
                  nothing, which confused users. Removed for now; can be
                  reintroduced later by adding a button here with a real handler
                  and re-importing the Settings icon from lucide-react. */}
            </div>
          </div>
        </div>
        <div className="px-4 pb-4">
          <div className="bg-gray-800/50 rounded-xl p-3 backdrop-blur">
            <div className="flex items-center justify-between">
              <ConnectionStatus
                connectionState={connectionState}
                reconnectAttempts={reconnectAttempts}
                onReconnect={onReconnect}
              />
              {/* [STEP 4B] Real radio frequency + battery, tap to open full
                  node diagnostics. Previously hardcoded "915MHz / 12km" —
                  wrong frequency (firmware runs 433MHz) and an unverified
                  range claim; both misled users about what they were
                  actually getting. */}
              <button
                onClick={onShowNodeStats}
                className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity"
              >
                <div className="flex items-center gap-1">
                  <Signal className="h-3.5 w-3.5 text-blue-500" />
                  <span className="text-gray-400">{RADIO_FREQUENCY_HZ / 1_000_000}MHz</span>
                </div>
                <Activity className="h-3.5 w-3.5 text-gray-500" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {pwaInstall.canInstall && (
        <div className="bg-blue-600 text-white p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sparkles className="h-5 w-5" />
              <div>
                <p className="font-medium">Install ATCS</p>
                <p className="text-xs opacity-90">Get offline access &amp; push notifications</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={pwaInstall.dismiss} className="text-white hover:bg-white/20">
                Later
              </Button>
              <Button size="sm" onClick={pwaInstall.install} className="bg-white text-blue-600 hover:bg-gray-100">
                Install Now
              </Button>
            </div>
          </div>
        </div>
      )}

      {connectionState === "error" && lastConnectionError && (
        <div className="bg-red-900/20 border border-red-800 text-red-400 p-3 mx-4 mb-2 rounded-lg text-sm">
          <div className="flex items-center justify-between">
            <span>{lastConnectionError}</span>
            <button onClick={onReconnect} className="text-red-300 hover:text-red-200">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="px-3 py-2 space-y-2 pb-8">
          {contacts.map((contact) => (
            <div key={contact.deviceId} className="relative">
              <div
                onClick={() => {
                  // If delete menu is open, close it instead of opening chat
                  if (showDeleteMenu === contact.deviceId) {
                    onToggleDeleteMenu(null);
                    return;
                  }
                  onOpenChat(contact);
                }}
                onTouchStart={() => contact.deviceId !== "*" && handleTouchStart(contact.deviceId)}
                onTouchEnd={() => contact.deviceId !== "*" && handleTouchEnd(contact.deviceId)}
                onTouchMove={() => contact.deviceId !== "*" && handleTouchEnd(contact.deviceId)}
                className="group relative overflow-hidden rounded-2xl p-3 cursor-pointer transition-all duration-300 active:scale-95 bg-gray-800 hover:bg-gray-700 border border-gray-700 transform hover:-translate-y-0.5 select-none"
              >
                <div className="absolute inset-0 bg-blue-600/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <Avatar
                        className={`h-12 w-12 ${
                          contact.deviceId === "*"
                            ? "bg-gradient-to-r from-orange-400 to-red-500"
                            : "bg-blue-600"
                        } shadow-lg`}
                      >
                        <div className="flex items-center justify-center h-full w-full text-white font-bold">
                          {contact.deviceId === "*" ? (
                            <Zap className="h-6 w-6" />
                          ) : (
                            contact.deviceId
                          )}
                        </div>
                      </Avatar>
                      {/* [v6] Range-aware status dot. The Emergency channel ("*")
                          is a pseudo-node with no real link, so it keeps a static
                          green dot; real nodes show online/stale/offline reachability. */}
                      {contact.deviceId === "*" ? (
                        <div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 bg-emerald-500 rounded-full border-2 border-gray-800" />
                      ) : (
                        <SignalIndicator
                          variant="dot"
                          reachability={contact.reachability}
                          className="absolute -bottom-0.5 -right-0.5"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-white truncate">{contact.deviceName}</p>
                        {contact.deviceId === "*" && (
                          <Shield className="h-4 w-4 text-orange-500 flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-sm text-gray-400 flex items-center gap-2">
                        <span className="flex items-center gap-1">
                          <Radio className="h-3 w-3" />
                          {contact.frequency / 1000000} MHz
                        </span>
                        <span>•</span>
                        <span>SF{contact.spreadingFactor}</span>
                        {contact.lastSeen && (
                          <>
                            <span>•</span>
                            <span className="text-xs">
                              {new Date(contact.lastSeen).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </>
                        )}
                      </p>
                      {/* [STEP 4A] Reachability + signal quality shown independently
                          (skip for the Emergency pseudo-node). */}
                      {contact.deviceId !== "*" && (
                        <div className="mt-0.5">
                          <SignalIndicator
                            variant="full"
                            reachability={contact.reachability}
                            signalQuality={contact.signalQuality}
                            rssi={contact.rssi}
                            signalSampledAt={contact.signalSampledAt}
                            signalHopDistance={contact.signalHopDistance}
                          />
                          {/* [STEP 8] battery display removed */}
                        </div>
                      )}
                      {contact.deviceId !== "*" && (
                        <p className="text-xs text-gray-600 mt-0.5 md:hidden">Hold to delete</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {contact.unreadCount > 0 && (
                      <div className="relative">
                        <div className="absolute inset-0 bg-blue-600 rounded-full blur animate-pulse" />
                        <Badge className="relative bg-blue-600 text-white border-0 rounded-full min-w-[24px] h-6">
                          {contact.unreadCount}
                        </Badge>
                      </div>
                    )}

                    {/* Trash icon: always visible on mobile, hover-visible on desktop */}
                    {contact.deviceId !== "*" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleDeleteMenu(
                            showDeleteMenu === contact.deviceId ? null : contact.deviceId,
                          );
                        }}
                        className={`rounded-full hover:bg-red-500/10 transition-opacity md:opacity-0 md:group-hover:opacity-100 ${
                          showDeleteMenu === contact.deviceId ? "opacity-100 bg-red-500/10" : ""
                        }`}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Delete confirmation panel — outside the card so it can't trigger onOpenChat */}
              {showDeleteMenu === contact.deviceId && (
                <div className="mt-1 mx-2 rounded-xl overflow-hidden border border-red-800/50 bg-gray-800 shadow-xl animate-[fade-in_0.15s_ease-out]">
                  <div className="px-4 py-3 flex items-center justify-between">
                    <p className="text-sm text-gray-300">
                      Remove <span className="font-semibold text-white">{contact.deviceName}</span>?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleDeleteMenu(null);
                        }}
                        className="px-3 py-1.5 text-sm text-gray-400 hover:text-white rounded-lg hover:bg-gray-700 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteContact(contact.deviceId);
                        }}
                        className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors font-medium"
                      >
                        Remove Device
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      <button
        onClick={onShowAddContact}
        className="fixed bottom-6 right-6 w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center group active:scale-95 z-10"
        style={{ boxShadow: "0 4px 12px rgba(150, 50, 45, 0.45)" }}
      >
        <UserPlus className="h-6 w-6 transition-transform group-hover:scale-110" />
        <div className="absolute inset-0 rounded-full bg-white opacity-0 group-hover:opacity-20 transition-opacity duration-300" />
      </button>
    </div>
  );
}
