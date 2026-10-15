/**
 * The table's column template, shared by the header row and every port row so they line up.
 * Six columns (port · process · status · memory · uptime · actions) once the main column is
 * 640 px wide; four below that (memory and uptime move to the inspector, which is what makes
 * the main column narrow in the first place). Every track is fixed or `1fr`, never `auto`: the
 * header and the rows are separate grids, and only equal tracks keep them aligned. The 104 px
 * status track fits the widest pill ("AI · 4.9 GB") and a brand mark; the secondary pills are
 * hidden at that width. `@container/main` is on the main column in App.vue.
 */
export const TABLE_COLUMNS =
  "grid items-center gap-x-2 px-4 grid-cols-[56px_minmax(0,1fr)_104px_76px] @min-[640px]/main:gap-x-2.5 @min-[640px]/main:grid-cols-[84px_minmax(0,1fr)_172px_78px_64px_80px]";

/** The memory and uptime cells: only with the six-column template. */
export const WIDE_ONLY = "hidden @min-[640px]/main:block";
