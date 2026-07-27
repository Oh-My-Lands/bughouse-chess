import type { EngineLine } from "@/app/utils/engine/engineClient";

/**
 * The candidates to show: the top `multipv`, plus the move actually played when
 * the engine ranked it below them.
 *
 * A ranking that stops at the user's line count answers "what should I have
 * played" but not "how bad was what I did" -- the move under review is exactly
 * the one most likely to have fallen outside the top few. Appended rather than
 * substituted, and carrying its own `multipv`, so it reads as what it is: the
 * played move, ranked 11th, not a fourth-best line.
 *
 * Only ever picks from `lines`. A move the search never reported has no
 * evaluation to show, so it is left out rather than rendered as a blank row --
 * which is also why this cannot guarantee the played move appears at all. How
 * often it can is set by how many lines the search asked for: REVIEW_MULTIPV
 * for a review, ENGINE_MULTIPV for a live search.
 */
export function linesWithPlayedMove(
  lines: readonly EngineLine[],
  multipv: number,
  playedMove: string | null | undefined,
): EngineLine[] {
  // Rank order is what makes the slice "the top N"; the transport does not
  // promise it.
  const ranked = [...lines].sort((a, b) => a.multipv - b.multipv);
  const top = ranked.slice(0, multipv);
  if (!playedMove) return top;

  const played = ranked.find((line) => line.move === playedMove);
  return played && !top.includes(played) ? [...top, played] : top;
}
