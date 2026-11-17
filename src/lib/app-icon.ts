/**
 * The app icon's own colours and geometry, for the in-app mark (`AppMark.vue`) and nothing else.
 * They are not tokens: the icon looks the same in light and dark, like the Dock icon. These are
 * design/icon.svg's, and `AppMark.test.ts` checks that the design sources still use them. The one
 * place outside the SVG sources that names them; only `AppMark.vue` imports this file (a test
 * holds that), so the "tokens only" rule of `contrast.test.ts` keeps its teeth everywhere else.
 */
export const APP_ICON = {
  /** The plate, top-left to bottom-right: Anodized Obsidian, Tactical Obsidian, Void Black. */
  plate: ["#1E222D", "#121316", "#0A0B0E"],
  /** The left bracket (`prism-left`): amber, Signal Coral, rose. */
  warm: ["#FFB74D", "#FF4528", "#E11D48"],
  /** The right bracket (`prism-right`): Azure, Violet, Signal Coral. */
  cool: ["#4EA1FF", "#A78BFA", "#FF4528"],
  /** The frosted-glass echo plate in the socket's cavity (`echo-glass`): white to violet. */
  glass: ["#FFFFFF", "#A78BFA"],
} as const;

/**
 * The left bracket: the socket's left half, cut by the tapered scythe arc and sheared along it.
 * Two separate paths, no mask: the gap is in the geometry.
 */
export const LEFT_BRACKET =
  "M166 264 A26 26 0 0 1 192 238 H492.4 Q465.6 291.7 442.2 346 H278 V566 H368.1 Q353.3 683 347.9 802 H294 A26 26 0 0 1 268 776 V674 H192 A26 26 0 0 1 166 648 Z";
/** The right bracket, displaced up and right along the cut. */
export const RIGHT_BRACKET =
  "M669.8 218 H830 A26 26 0 0 1 856 244 V630 A26 26 0 0 1 830 656 H756 V756 A26 26 0 0 1 730 782 H499.1 Q503.8 728 512.7 674 H648 V546 H746 V326 H613.2 Q639.7 271.7 669.8 218 Z";
/** The echo plate in the socket's cavity, as a rounded rectangle. */
export const ECHO = { x: 252, y: 298, width: 520, height: 296, rx: 44 } as const;
