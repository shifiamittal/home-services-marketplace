import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./pilot.css";

export const metadata: Metadata = {
  title: "Nivasa — Home Help Marketplace",
  description: "A refined, dignified marketplace experience for residents and home helpers.",
  openGraph: {
    title: "Nivasa — Home Help Marketplace",
    description: "Trusted home help, thoughtfully matched.",
    images: [{
      url: "https://nivasa-home-help.nivasa-app.workers.dev/og.png",
      width: 1731,
      height: 909,
      alt: "Nivasa — Trusted home help, thoughtfully matched.",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Nivasa — Home Help Marketplace",
    description: "Trusted home help, thoughtfully matched.",
    images: ["https://nivasa-home-help.nivasa-app.workers.dev/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
