/**
 * The icon's own colours, for the in-app mark (`BrandMark.vue`). They are not tokens: the icon
 * looks the same in light and dark, like the Dock icon, and these are design/icon.svg's (its
 * `warm` and `cool` gradients; the plate is its Tactical Obsidian). The one place outside the
 * SVG sources that names them; components take them from here, never as a literal hex.
 */
export const BRAND = {
  /** Tactical Obsidian: the plate. */
  plate: "#121316",
  /** The glass panel in the socket's opening (drawn at 6 %). */
  glass: "#FFFFFF",
  /** The left piece, the one the cut swept: Neon Amber to Signal Coral, top to bottom. */
  warm: ["#FF9A3C", "#FF4528"],
  /** The right piece: Azure to Violet, top to bottom. */
  cool: ["#4EA1FF", "#A78BFA"],
} as const;
