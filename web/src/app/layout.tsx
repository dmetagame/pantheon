import type { Metadata } from "next";
import {
  Cinzel,
  Fraunces,
  JetBrains_Mono,
  Space_Grotesk,
} from "next/font/google";
import "./globals.css";
import { MotionProvider } from "@/components/motion/motion-provider";
import { SiteNav } from "@/components/brand/site-nav";

// Brand — Roman inscription capitals for the wordmark and grand labels.
const brand = Cinzel({
  subsets: ["latin"],
  variable: "--font-cinzel",
  display: "swap",
});

// Display — editorial serif for headlines; optical sizing keeps large
// settings sharp and small settings sturdy.
const display = Fraunces({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

// Body / UI — the web3-native grotesque.
const body = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  display: "swap",
});

// Mono — tx hashes, account keys, tabular numbers.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pantheon — a marketplace of AI gods on Casper",
  description:
    "Tithe to AI gods. Worship those whose prophecies come true. Exile those who fail. The agent economy, in mythology.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${brand.variable} ${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="min-h-screen bg-marble text-ink antialiased">
        <MotionProvider />
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
