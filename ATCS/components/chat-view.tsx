// ─────────────────────────────────────────────────────────────────────────────
// components/chat-view.tsx
//
// The individual conversation screen shown when a contact is opened.
//
// Emergency broadcast visual treatment:
//   • The chat header turns red/orange instead of the normal blue.
//   • Incoming emergency messages get a red/orange background with a ⚠ icon.
//   • Outgoing emergency messages keep the same visual treatment so the
//     sender can see the broadcast was sent.
//   • A persistent red banner below the header reminds the user they are
//     in "Emergency Broadcast" mode.
//   • The send button glows red when in emergency mode.
//
// [NEW] MESSAGE DELETION UI
//   This view now supports deleting messages. There are two ways:
//     1. Single delete — hover (desktop) or long-press (mobile) a message to
//        reveal a small trash button on that one bubble.
//     2. Selection mode — tap the "select" icon in the header to enter a mode
//        where tapping bubbles toggles a checkmark; a toolbar then lets you
//        delete all selected messages at once.
//   A "clear all" trash icon in the header wipes the whole conversation
//   (after a confirmation). Everything works the same for private and
//   emergency chats — the parent (fling-app) decides which thread to edit.
//
//   IMPORTANT: this component never stores messages itself. It only calls the
//   callbacks passed in as props (onDeleteMessage / onDeleteMessages /
//   onClearConversation). The parent owns the state and persistence, so the UI
//   updates instantly and the change is saved automatically.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, type RefObject } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  Compass,
  Radio,
  Send,
  Signal,
  Trash2,
  WifiOff,
  X,
  Zap,
} from "lucide-react";

import { Avatar }            from "@/components/ui/avatar";
import { Button }            from "@/components/ui/button";
import { Input }             from "@/components/ui/input";
import { ScrollArea }        from "@/components/ui/scroll-area";
import { ConnectionStatus }  from "@/components/connection-status";
import { SignalIndicator }   from "@/components/signal-indicator";
import type { Contact, ConnectionState, Message } from "@/lib/types";

interface ChatViewProps {
  contact: Contact;
  messages: Message[];
  inputValue: string;
  onInputChange: (value: string) => void;
  isTyping: boolean;
  isOnline: boolean;
  connectionState: ConnectionState;
  reconnectAttempts: number;
  keyboardHeight: number;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onRequestLocation: () => void;
  onSendMessage: () => void;
  onReconnect: () => void;
  // [NEW] Deletion callbacks. The parent (fling-app) supplies these and already
  // knows which thread we're in, so this component just passes message ids.
  onDeleteMessage: (messageId: string) => void;
  onDeleteMessages: (messageIds: string[]) => void;
  onClearConversation: () => void;
}

export function ChatView({
  contact,
  messages,
  inputValue,
  onInputChange,
  isTyping,
  isOnline,
  connectionState,
  reconnectAttempts,
  keyboardHeight,
  messagesEndRef,
  onBack,
  onRequestLocation,
  onSendMessage,
  onReconnect,
  onDeleteMessage,
  onDeleteMessages,
  onClearConversation,
}: ChatViewProps) {
  // isEmergency controls all special visual treatment in this view.
  const isEmergency = contact.deviceId === "*";

  // ── [NEW] Deletion-related local UI state ──────────────────────────────────
  // selectionMode: are we currently in multi-select mode?
  const [selectionMode, setSelectionMode] = useState(false);
  // selectedIds: which message ids are currently checked. A Set gives fast
  // has()/add()/delete() and avoids duplicates.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // showClearConfirm: controls the "clear entire conversation?" confirm dialog.
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // longPressMessageId: which single message currently shows its inline trash
  // button on touch devices (set by a long-press, cleared by tapping elsewhere).
  const [longPressMessageId, setLongPressMessageId] = useState<string | null>(null);

  // If the messages list empties (e.g. after "clear all") or the contact
  // changes, leave selection mode and reset everything so the UI is clean.
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setLongPressMessageId(null);
  }, [contact.deviceId]);

  // ── Selection helpers ──────────────────────────────────────────────────────

  // Toggle whether a single message is selected. Always returns a NEW Set so
  // React detects the state change and re-renders.
  const toggleSelected = (messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  // Enter selection mode, optionally pre-selecting one message (used when a
  // long-press "Select" is chosen so the pressed message starts checked).
  const enterSelectionMode = (preselectId?: string) => {
    setSelectionMode(true);
    setLongPressMessageId(null);
    if (preselectId) setSelectedIds(new Set([preselectId]));
  };

  // Leave selection mode and clear any checks.
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // Delete every currently-selected message in one call, then exit the mode.
  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    onDeleteMessages(Array.from(selectedIds));
    exitSelectionMode();
  };

  // Confirm + perform "clear entire conversation".
  const handleClearConfirmed = () => {
    onClearConversation();
    setShowClearConfirm(false);
    exitSelectionMode();
  };

  // Long-press timer handling for touch devices. Holding a bubble for ~500ms
  // reveals its inline delete button.
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const handleTouchStart = (messageId: string) => {
    longPressTimer = setTimeout(() => setLongPressMessageId(messageId), 500);
  };
  const handleTouchEnd = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
  };

  return (
    <div className="app-container h-full w-full">
      <ScrollArea
        className="h-full w-full pt-[100px] transition-all duration-300 ease-in-out"
        style={{ paddingBottom: `${90 + keyboardHeight + 12}px` }}
      >
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-center my-4">
            <div className="px-4 py-1 rounded-full text-xs bg-gray-700 text-gray-300">Today</div>
          </div>

          {/* [NEW] Empty-state hint shown after a conversation is cleared. */}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center mb-3">
                <Radio className="h-6 w-6 text-gray-500" />
              </div>
              <p className="text-sm text-gray-500">No messages yet</p>
            </div>
          )}

          {messages.map((message) => {
            const isSelected = selectedIds.has(message.id);
            return (
              <div
                key={message.id}
                className={`flex ${message.isMe ? "justify-end" : "justify-start"} animate-[fade-in_0.3s_ease-out]`}
                // In selection mode, tapping anywhere on the row toggles selection.
                onClick={() => {
                  if (selectionMode) toggleSelected(message.id);
                }}
              >
                {/* [NEW] Selection checkbox shown on the left while selecting. */}
                {selectionMode && (
                  <div className="flex items-center mr-2 flex-shrink-0">
                    <div
                      className={`h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                        isSelected
                          ? "bg-blue-600 border-blue-600"
                          : "border-gray-500"
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3 text-white" />}
                    </div>
                  </div>
                )}

                <div
                  className="group relative max-w-[75%]"
                  // Long-press reveals the single-message trash button (touch).
                  onTouchStart={() => !selectionMode && handleTouchStart(message.id)}
                  onTouchEnd={handleTouchEnd}
                  onTouchMove={handleTouchEnd}
                >
                  {/* Emergency incoming messages get a distinct red/amber bubble. */}
                  <div
                    className={`relative rounded-2xl px-4 py-2 shadow-sm transition-all ${
                      isSelected ? "ring-2 ring-blue-400" : ""
                    } ${
                      message.isMe
                        ? message.status === "failed"
                          ? "bg-red-500 text-white"
                          : isEmergency
                            ? "bg-gradient-to-r from-orange-600 to-red-600 text-white border border-red-500/50"
                            : "bg-blue-600 text-white"
                        : isEmergency
                          ? "bg-gradient-to-r from-orange-900/80 to-red-900/80 text-white border border-orange-700/60"
                          : "bg-gray-800 text-white border border-gray-700"
                    }`}
                  >
                    {/* Warning icon + per-message sender identity for incoming
                        emergency messages. */}
                    {isEmergency && !message.isMe && (
                      <div className="flex items-center gap-1.5 mb-1">
                        <AlertTriangle className="h-3.5 w-3.5 text-orange-400 flex-shrink-0" />
                        <span className="text-xs text-orange-300 font-semibold tracking-wide">
                          {message.senderName || "Emergency Broadcast"}
                        </span>
                      </div>
                    )}
                    <p className="text-sm leading-relaxed break-words">{message.content}</p>
                    <div
                      className={`flex items-center justify-end gap-2 mt-1 ${
                        message.isMe ? "text-blue-100" : "text-gray-400"
                      }`}
                    >
                      <p className="text-xs">
                        {message.timestamp.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                      {message.isMe && (
                        <div className="flex items-center">
                          {message.status === "sending" && (
                            <div className="w-3 h-3 rounded-full border-2 border-current animate-spin" />
                          )}
                          {message.status === "sent" && (
                            <Check className="w-4 h-4" />
                          )}
                          {message.status === "delivered" && (
                            <CheckCheck className="w-4 h-4" />
                          )}
                          {message.status === "read" && (
                            <CheckCheck className="w-4 h-4 text-blue-300" />
                          )}
                          {message.offline && <WifiOff className="w-3 h-3 ml-1" />}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* [NEW] Single-message delete button.
                      Desktop: appears on hover (md:group-hover).
                      Mobile: appears after a long-press on this bubble.
                      Hidden entirely while in multi-select mode. */}
                  {!selectionMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();      // don't trigger row onClick
                        onDeleteMessage(message.id);
                        setLongPressMessageId(null);
                      }}
                      className={`absolute -top-2 ${
                        message.isMe ? "-left-2" : "-right-2"
                      } h-7 w-7 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center shadow-lg transition-opacity ${
                        longPressMessageId === message.id
                          ? "opacity-100"
                          : "opacity-0 md:group-hover:opacity-100 pointer-events-none md:pointer-events-auto"
                      }`}
                      aria-label="Delete message"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* ── Fixed header ─────────────────────────────────────────────────── */}
      <div className="fixed top-0 left-0 right-0 z-10 bg-gray-800/80 backdrop-blur-lg border-b border-gray-700 shadow-sm">
        <div className="px-4 pt-12 pb-3">
          {selectionMode ? (
            // [NEW] SELECTION-MODE HEADER: shows count + cancel + delete-selected.
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={exitSelectionMode}
                  className="rounded-full hover:bg-gray-700 -ml-2"
                  aria-label="Cancel selection"
                >
                  <X className="h-5 w-5 text-gray-300" />
                </Button>
                <p className="font-semibold text-white">
                  {selectedIds.size} selected
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0}
                className="rounded-full hover:bg-red-500/10 disabled:opacity-40"
                aria-label="Delete selected messages"
              >
                <Trash2 className="h-5 w-5 text-red-400" />
              </Button>
            </div>
          ) : (
            // NORMAL HEADER (with new select + clear-all actions on the right).
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onBack}
                  className="rounded-full hover:bg-gray-700 -ml-2 flex-shrink-0"
                >
                  <ArrowLeft className="h-5 w-5 text-gray-300" />
                </Button>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative flex-shrink-0">
                    <Avatar
                      className={`h-10 w-10 shadow-lg ${
                        isEmergency
                          ? "bg-gradient-to-r from-orange-500 to-red-600"
                          : "bg-blue-600"
                      }`}
                    >
                      <div className="flex items-center justify-center h-full w-full text-white font-bold">
                        {isEmergency ? <Zap className="h-5 w-5" /> : contact.deviceId}
                      </div>
                    </Avatar>
                    <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 bg-emerald-500 rounded-full border-2 border-gray-800" />
                  </div>
                  <div className="min-w-0">
                    <p className={`font-semibold truncate ${isEmergency ? "text-orange-300" : "text-white"}`}>
                      {contact.deviceName}
                    </p>
                    <p className="text-xs text-gray-400 flex items-center gap-2">
                      <Radio className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">
                        {contact.frequency ? `${contact.frequency / 1000000} MHz` : ""}
                      </span>
                      <span>•</span>
                      {/* [v6] For a real node, show its LoRa range status (online /
                          weak / out of range) from the range monitor. The Emergency
                          channel has no single remote node, so it falls back to the
                          local Wi-Fi link status (isOnline). */}
                      {isEmergency ? (
                        isOnline ? (
                          <span className="text-emerald-400 font-medium">Online</span>
                        ) : (
                          <span className="text-orange-400">Offline</span>
                        )
                      ) : (
                        <SignalIndicator
                          variant="full"
                          status={contact.status}
                          rssi={contact.rssi}
                        />
                      )}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {/* [NEW] Enter selection mode (only useful if there are messages). */}
                {messages.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => enterSelectionMode()}
                    className="rounded-full hover:bg-gray-700"
                    aria-label="Select messages"
                  >
                    <Check className="h-5 w-5 text-gray-300" />
                  </Button>
                )}
                {/* [NEW] Clear entire conversation. */}
                {messages.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowClearConfirm(true)}
                    className="rounded-full hover:bg-red-500/10"
                    aria-label="Clear conversation"
                  >
                    <Trash2 className="h-5 w-5 text-red-400" />
                  </Button>
                )}
                {!isEmergency && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onRequestLocation}
                    className="rounded-full hover:bg-gray-700"
                  >
                    <Compass className="h-5 w-5 text-gray-300" />
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="rounded-full hover:bg-gray-700">
                  <Signal className="h-5 w-5 text-gray-300" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Emergency mode persistent banner (hidden while selecting to keep the
            selection toolbar uncluttered). */}
        {isEmergency && !selectionMode && (
          <div className="mx-4 mb-3 bg-red-900/40 border border-red-700/60 rounded-xl px-3 py-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 animate-pulse" />
            <p className="text-xs text-red-300 font-medium">
              EMERGENCY BROADCAST — message will reach ALL active nodes
            </p>
          </div>
        )}

        {connectionState !== "connected" && (
          <div className="px-4 pb-2">
            <div className="bg-gray-700/50 rounded-lg px-3 py-2 flex items-center justify-between">
              <ConnectionStatus
                connectionState={connectionState}
                reconnectAttempts={reconnectAttempts}
                onReconnect={onReconnect}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Fixed input bar ─────────────────────────────────────────────── */}
      <div
        className="fixed left-0 right-0 z-10 bg-gray-800 border-t border-gray-800 px-4 pt-1 pb-safe transition-all duration-300 ease-in-out"
        style={{ bottom: `${keyboardHeight}px` }}
      >
        <div className="px-4 pt-1 pb-safe">
          {!isOnline && (
            <div className="mb-2 flex items-center justify-center gap-2 text-xs text-orange-400 bg-orange-500/10 rounded-full py-1.5">
              <WifiOff className="h-3 w-3" />
              Messages will be sent when connection is restored
            </div>
          )}
          <div className="flex items-end gap-2 pb-4">
            <div className="flex-1 relative">
              <Input
                value={inputValue}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder={isEmergency ? "Type emergency message…" : "Type your message..."}
                className={`rounded-full text-base bg-gray-700 text-white placeholder:text-gray-400 transition-all focus:ring-2 px-4 py-3 min-h-[48px] resize-none ${
                  isEmergency
                    ? "border-red-700/60 focus:ring-red-500"
                    : "border-gray-600 focus:ring-blue-500"
                }`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSendMessage();
                  }
                }}
                onFocus={() => {
                  setTimeout(() => {
                    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
                  }, 300);
                }}
              />
            </div>
            {/* Send button glows red in emergency mode */}
            <Button
              onClick={onSendMessage}
              size="icon"
              className={`rounded-full transition-all h-12 w-12 flex-shrink-0 ${
                inputValue.trim()
                  ? isEmergency
                    ? "bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-700 hover:to-red-700 shadow-lg shadow-red-500/30 active:scale-95 text-white"
                    : "bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/25 active:scale-95 text-white"
                  : "bg-gray-700 hover:bg-gray-600 text-gray-400"
              }`}
              disabled={!inputValue.trim()}
            >
              {isEmergency && inputValue.trim()
                ? <Zap className="h-5 w-5" />
                : <Send className="h-5 w-5" />
              }
            </Button>
          </div>
        </div>
      </div>

      {/* ── [NEW] Clear-conversation confirmation dialog ─────────────────── */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-3xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex flex-col items-center text-center">
              <div className="w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center mb-4">
                <Trash2 className="h-7 w-7 text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">
                Clear conversation?
              </h3>
              <p className="text-sm text-gray-400 mb-6">
                This permanently deletes all {messages.length} message
                {messages.length === 1 ? "" : "s"} in this chat. This cannot be undone.
              </p>
              <div className="flex gap-3 w-full">
                <Button
                  variant="outline"
                  onClick={() => setShowClearConfirm(false)}
                  className="flex-1 border-gray-600 text-gray-300 hover:bg-gray-700"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleClearConfirmed}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                >
                  Clear all
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
