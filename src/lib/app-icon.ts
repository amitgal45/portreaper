/**
 * The app icon's own colours and geometry, for the in-app mark (`AppMark.vue`) and nothing else.
 * They are not tokens: the icon looks the same in light and dark, like the Dock icon. These are
 * design/icon.svg's, and `AppMark.test.ts` checks that the design sources still use them. The one
 * place outside the SVG sources that names them; only `AppMark.vue` imports this file (a test
 * holds that), so the "tokens only" rule of `contrast.test.ts` keeps its teeth everywhere else.
 */
export const APP_ICON = {
  /** Tactical Obsidian: the plate. */
  plate: "#121316",
  /** The glass panel in the socket's opening (drawn at 6 %). */
  glass: "#FFFFFF",
  /** The left piece, the one the cut swept: Neon Amber to Signal Coral, top to bottom. */
  warm: ["#FF9A3C", "#FF4528"],
  /** The right piece: Azure to Violet, top to bottom. */
  cool: ["#4EA1FF", "#A78BFA"],
} as const;

/** The socket: a bold ring with the latch tab below (outer boundary, then the opening), even-odd. */
export const SOCKET =
  "M184 258 A24 24 0 0 1 208 234 H816 A24 24 0 0 1 840 258 V646 A24 24 0 0 1 816 670 H730 V766 A24 24 0 0 1 706 790 H318 A24 24 0 0 1 294 766 V670 H208 A24 24 0 0 1 184 646 Z M280 330 V574 H390 V694 H634 V574 H744 V330 Z";
/** The socket's opening, where the glass panel sits. */
export const OPENING = "M280 330 V574 H390 V694 H634 V574 H744 V330 Z";
/** The cut: one quadratic arc, stroked 88 px wide with square ends through the mask. */
export const CUT = "M388 892 Q398 475 636 132";
/** Everything left of the cut's centreline (the warm piece); the straight runs lie off the glyph. */
export const LEFT = "M0 0 H680 L636 132 Q398 475 388 892 L380 1024 H0 Z";
/** Everything right of it (the cool piece): the same boundary, so the two cover the glyph once. */
export const RIGHT = "M1024 0 H680 L636 132 Q398 475 388 892 L380 1024 H1024 Z";
