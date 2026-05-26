import { useCallback, useEffect, useState } from "react";
import type { BeforeInstallPromptEvent } from "@/lib/types";

interface UsePwaInstallResult {
  canInstall: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
}

export function usePwaInstall(): UsePwaInstallResult {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setCanInstall(false);
  }, [deferredPrompt]);

  const dismiss = useCallback(() => setCanInstall(false), []);

  return { canInstall, install, dismiss };
}
