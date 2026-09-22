import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./avatars.css";

export const metadata: Metadata = { title: "klaʊdbot", description: "Rein field systems · Field console / 01", icons: { icon: "/icon.svg", apple: "/icon.png" } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#12100e" };
export const dynamic = "force-dynamic";
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" data-dark="true" data-accent="rain" data-density="regular"><body>{children}</body></html>;
}