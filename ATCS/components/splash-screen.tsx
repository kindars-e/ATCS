import { Shield, WifiOff } from "lucide-react";
import { FlingLogo } from "./fling-logo";

export function SplashScreen() {
  return (
    <div className="app-container flex items-center justify-center overflow-hidden bg-gray-900">
      <div className="absolute inset-0">
        {[...Array(20)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-white"
            style={{
              width: `${Math.random() * 1.5 + 0.5}px`,
              height: `${Math.random() * 1.5 + 0.5}px`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              opacity: Math.random() * 0.6 + 0.2,
              animation: `twinkle ${Math.random() * 3 + 2}s linear ${Math.random() * 3}s infinite`,
            }}
          />
        ))}
        {[...Array(5)].map((_, i) => (
          <div
            key={`bright-${i}`}
            className="absolute rounded-full bg-white"
            style={{
              width: "2px",
              height: "2px",
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              opacity: 0.8,
              boxShadow: "0 0 6px rgba(255, 255, 255, 0.3)",
              animation: `twinkle ${Math.random() * 4 + 3}s ease-in-out ${Math.random() * 3}s infinite`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 text-center">
        <div className="relative mb-8">
          <div className="relative w-48 h-48 mx-auto flex items-center justify-center">
            <div className="absolute inset-0 bg-white/5 blur-3xl" />
            <FlingLogo
              className="w-40 h-40 text-white relative z-10"
              style={{ filter: "drop-shadow(0 10px 25px rgba(0, 0, 0, 0.5))" }}
            />
          </div>
        </div>

        <h1 className="text-3xl font-bold text-white mb-2 tracking-tight opacity-0 animate-[fade-in_1s_ease-out_0.3s_forwards]">
          ATCS
        </h1>
        <p className="text-gray-400 text-sm mb-1 opacity-0 animate-[fade-in_1s_ease-out_0.45s_forwards]">
          Alternative Text-based Communication System
        </p>
        <p className="text-gray-500 text-xs mb-16 opacity-0 animate-[fade-in_1s_ease-out_0.6s_forwards]">
          Communication when there is no network
        </p>

        <div className="flex items-center justify-center gap-2">
          <div className="w-2 h-2 bg-white rounded-full opacity-30 animate-pulse" />
          <div
            className="w-2 h-2 bg-white rounded-full opacity-60 animate-pulse"
            style={{ animationDelay: "0.2s" }}
          />
          <div
            className="w-2 h-2 bg-white rounded-full opacity-100 animate-pulse"
            style={{ animationDelay: "0.4s" }}
          />
        </div>
      </div>

      <div className="absolute bottom-12 left-0 right-0 text-center opacity-0 animate-[fade-in_1s_ease-out_0.7s_forwards]">
        <div className="flex items-center justify-center gap-6 text-gray-600 text-xs mb-3">
          <div className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            <span>Emergency Ready</span>
          </div>
          <div className="flex items-center gap-1.5">
            <WifiOff className="h-3.5 w-3.5" />
            <span>Works Without Internet</span>
          </div>
        </div>
        <p className="text-gray-700 text-xs">Version 1.0.0</p>
      </div>
    </div>
  );
}
