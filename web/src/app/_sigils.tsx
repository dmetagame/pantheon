import type { GodId } from "@pantheon/agents";

interface SigilProps {
  godId: GodId;
  className?: string;
}

// Minimal line-drawn sigils. 24×24, centered, currentColor stroke. Kept simple
// so they read as marks rather than illustrations at thumb size.
export function Sigil({ godId, className }: SigilProps) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };
  if (godId === "demeter") {
    // Wheat ear: vertical stalk with paired grains stepping down.
    return (
      <svg {...common}>
        <path d="M12 3v18" />
        <path d="M12 7 L8.5 5.5 M12 7 L15.5 5.5" />
        <path d="M12 11 L8 9 M12 11 L16 9" />
        <path d="M12 15 L7.5 12.5 M12 15 L16.5 12.5" />
        <path d="M12 19 L7 16 M12 19 L17 16" />
      </svg>
    );
  }
  if (godId === "hermes") {
    // Caduceus distilled: central staff, two crossing curves, winged tips.
    return (
      <svg {...common}>
        <path d="M12 3v18" />
        <path d="M9 7c0 2 6 2 6 5s-6 2-6 5" />
        <path d="M7 5l5 1.5 5-1.5" />
        <path d="M8.5 5.5c-1.5-0.5-2.5-1.5-3-2.5" />
        <path d="M15.5 5.5c1.5-0.5 2.5-1.5 3-2.5" />
      </svg>
    );
  }
  // apollo — lyre/sunburst: a circle with 8 rays.
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3v3.5 M12 17.5V21 M3 12h3.5 M17.5 12H21" />
      <path d="M5.6 5.6l2.5 2.5 M15.9 15.9l2.5 2.5 M18.4 5.6l-2.5 2.5 M8.1 15.9l-2.5 2.5" />
    </svg>
  );
}

interface AccentTokens {
  text: string;
  border: string;
  bg: string;
  ring: string;
}

export const GOD_ACCENT: Record<GodId, AccentTokens> = {
  demeter: {
    text: "text-laurel",
    border: "border-laurel/40",
    bg: "bg-laurel/5",
    ring: "ring-laurel/30",
  },
  hermes: {
    text: "text-gold",
    border: "border-gold/50",
    bg: "bg-gold/5",
    ring: "ring-gold/40",
  },
  apollo: {
    text: "text-amphora",
    border: "border-amphora/50",
    bg: "bg-amphora/5",
    ring: "ring-amphora/30",
  },
};
