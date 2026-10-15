/**
 * The colour bar of a project group. Hashed from the group's name over the five pill colours,
 * so a project keeps its colour from session to session and two projects side by side rarely
 * share one; the mock (d-board.html) varies the bars the same way. Not by category: four web
 * projects in a row would all be blue, and the bar is there to tell groups apart.
 */
const PALETTE = ["bg-blue", "bg-orange", "bg-purple", "bg-green", "bg-red"] as const;

export type GroupColour = (typeof PALETTE)[number];

export function groupColour(name: string): GroupColour {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] as GroupColour;
}
