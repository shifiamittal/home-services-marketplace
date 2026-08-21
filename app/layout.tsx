import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Premium Household Help Marketplace Mocks",
  description: "A refined mobile-first marketplace prototype for recurring household professionals in Omaxe New Chandigarh.",
  openGraph: {
    title: "Reliable home support, chosen with confidence.",
    description: "Private beta · Omaxe New Chandigarh",
    images: ["/nivasa-social-card.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Reliable home support, chosen with confidence.",
    description: "Private beta · Omaxe New Chandigarh",
    images: ["/nivasa-social-card.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
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
