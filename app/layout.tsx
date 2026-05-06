import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neon Cove — Synthwave Pirate Platformer",
  description: "A neon-glow platformer set in a pirate cove. Double jump, stomp enemies, chase the high score.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
