import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import "./globals.css";

import Footer from "@/components/Footer";
import InstallPrompt from "@/components/InstallPrompt";
import Navbar from "@/components/Navbar";
import Providers from "@/components/Providers";
import PwaRegister from "@/components/PwaRegister";
import SOSFab from "@/components/SOSFab";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

const APP_NAME = "ResQ AI";

/** Absolute base for metadata URLs (Open Graph etc.); tolerates a missing/invalid env var. */
function metadataBaseUrl(): URL {
  try {
    return new URL(process.env.NEXTAUTH_URL || "http://localhost:3000");
  } catch {
    return new URL("http://localhost:3000");
  }
}

const APP_DESCRIPTION =
  "AI-powered disaster response assistant: live disaster alerts, real weather hazards, nearby hospitals and shelters, community incident reports and one-tap SOS.";

export const metadata: Metadata = {
  metadataBase: metadataBaseUrl(),
  applicationName: APP_NAME,
  title: {
    default: `${APP_NAME} — Disaster Response Assistant`,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: APP_NAME,
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: `${APP_NAME} — Disaster Response Assistant`,
    description: APP_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#dc2626",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body
        className={`${inter.className} flex min-h-screen flex-col bg-slate-950 text-foreground antialiased pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0`}
      >
        <a
          href="#main"
          className="sr-only z-[100] rounded-lg bg-red-600 px-4 py-2 font-semibold text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:outline-none focus:ring-2 focus:ring-white"
        >
          Skip to main content
        </a>
        <Providers>
          <Navbar />
          <main id="main" tabIndex={-1} className="flex-grow focus:outline-none">
            {children}
          </main>
          <Footer />
          <SOSFab />
          <InstallPrompt />
          <PwaRegister />
        </Providers>
      </body>
    </html>
  );
}
