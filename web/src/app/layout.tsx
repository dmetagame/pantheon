import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body className="min-h-screen bg-marble text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
