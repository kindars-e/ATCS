import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ATCS — Alternative Text-based Communication System",
  description: "Offline emergency communication system — stay connected even without internet.",
  generator: "Next.js",
  manifest: "/manifest.webmanifest",
  keywords: ["ATCS", "offline", "emergency", "communication", "LoRa", "off-grid", "pwa"],
  authors: [{ name: "ATCS" }],
  icons: [
    { rel: "apple-touch-icon", url: "/icon-192x192.png" },
    { rel: "icon", url: "/icon-192x192.png" },
  ],
};

export const viewport: Viewport = {
  themeColor: "#3a1518", // ATCS dark brick-red base
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icon-192x192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="ATCS" />
        <meta name="mobile-web-app-capable" content="yes" />
        <style>{`
          /* Prevent white flash on load — ATCS warm charcoal base */
          html, body {
            background-color: #2b1416 !important;
            min-height: 100vh;
          }
          
          /* Hide everything until React loads */
          body {
            opacity: 0;
            transition: opacity 0.3s ease-in-out;
          }
          
          body.loaded {
            opacity: 1;
          }
        `}</style>
        <script dangerouslySetInnerHTML={{
          __html: `
            // Add loaded class when React mounts
            if (typeof window !== 'undefined') {
              window.addEventListener('load', function() {
                setTimeout(function() {
                  document.body.classList.add('loaded');
                }, 100);
              });
            }
          `
        }} />
      </head>
      <body className={`${inter.className} bg-gray-900`} style={{ backgroundColor: "#2b1416" }}>{children}</body>
    </html>
  );
}
