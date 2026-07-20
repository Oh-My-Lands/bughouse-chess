import { getTeamTimeDiffDeciseconds } from "@/app/utils/board/clockAdvantage";
import type { BughouseTeam } from "@/app/utils/board/clockAdvantage";
import type { BughouseBoardId, BughouseSide } from "@/app/types/analysis";
import type { BughouseClocksSnapshotByBoard } from "@/app/types/bughouse";

/**
 * Derives the engine's `Mode` and `Team` options from the board the user is
 * analysing and the clocks at the current ply.
 *
 * `Mode` is the engine's entire time model: a single boolean
 * (`teamHasTimeAdvantage`) that decides whether both partners may sit at once.
 * It feeds an NN input plane and is hashed into the position key, so it is not
 * a cosmetic setting -- changing it invalidates the search tree and genuinely
 * changes the evaluation.
 *
 * Since it tracks something real about the position, it defaults to being
 * derived from the clocks, with a manual override for analysing hypotheticals.
 */

/** Engine option value. "sit" means the team may double-sit. */
export type EngineMode = "go" | "sit";

/** Three-state control: auto follows the clocks, the others pin it. */
export type EngineModeSetting = "auto" | EngineMode;

/**
 * Below this, the clocks count as level and we assume "go".
 *
 * Without a deadband the mode would flip on every ply whenever the clocks are
 * near even, and each flip invalidates the tree. 15 deciseconds (1.5s) sits
 * between the first two tiers getAdvantageTier already uses, so the threshold
 * is consistent with what the clock display calls a meaningful lead.
 */
export const DEFAULT_DEADBAND_DECISECONDS = 15;

export interface ModeDerivationInput {
  /** Board the user is analysing. */
  board: BughouseBoardId;
  /** Colour the user is playing on that board. */
  side: BughouseSide;
  /** Clocks at the ply being analysed; null when the position has none. */
  clocks: BughouseClocksSnapshotByBoard | null;
  /** User's three-state choice. */
  setting: EngineModeSetting;
  deadbandDeciseconds?: number;
}

export interface ModeDerivationResult {
  /** What to send as `setoption name Mode`. */
  mode: EngineMode;
  /** What auto resolves to right now, regardless of the setting in force. */
  autoMode: EngineMode;
  /** True when the manual override is what decided `mode`. */
  isOverridden: boolean;
  /**
   * True when auto has nothing to work from -- a position entered by hand has
   * no clocks. The UI should say so rather than implying auto is tracking
   * something.
   */
  autoUnavailable: boolean;
  /** Signed team time difference, or null without clocks. Exposed for display. */
  diffDeciseconds: number | null;
}

/**
 * Maps a board and colour onto the team pairing the clocks are scored by.
 *
 * Bughouse teams are diagonal: A-White partners B-Black. So board A white and
 * board B black are the same team, and the naive "white is team 1" is wrong for
 * board B.
 */
export function teamFor(board: BughouseBoardId, side: BughouseSide): BughouseTeam {
  const isTeamOne = (board === "A") === (side === "white");
  return isTeamOne ? "AWhite_BBlack" : "ABlack_BWhite";
}

/**
 * Maps a board and colour onto the engine's `Team` option.
 *
 * The engine does not take a board -- it plays `teamSide` on board A and the
 * opposite colour on board B (see UCI::policy). So a user sitting at board B as
 * white is, in the engine's terms, playing team black.
 */
export function engineTeamColour(
  board: BughouseBoardId,
  side: BughouseSide,
): BughouseSide {
  if (board === "A") return side;
  return side === "white" ? "black" : "white";
}

/** Resolves Mode from the clocks and the user's setting. */
export function deriveEngineMode(
  input: ModeDerivationInput,
): ModeDerivationResult {
  const deadband = input.deadbandDeciseconds ?? DEFAULT_DEADBAND_DECISECONDS;

  const diffDeciseconds = input.clocks
    ? getTeamTimeDiffDeciseconds(input.clocks)
    : null;

  let autoMode: EngineMode = "go";
  if (diffDeciseconds !== null) {
    const team = teamFor(input.board, input.side);
    // The diff is signed towards team AWhite_BBlack, so the other team reads it
    // inverted.
    const lead =
      team === "AWhite_BBlack" ? diffDeciseconds : -diffDeciseconds;
    // Inside the deadband we fall back to "go", the more restrictive assumption:
    // it does not grant the option of double-sitting on a lead that is noise.
    autoMode = lead > deadband ? "sit" : "go";
  }

  const isOverridden = input.setting !== "auto";
  return {
    mode: isOverridden ? (input.setting as EngineMode) : autoMode,
    autoMode,
    isOverridden,
    autoUnavailable: diffDeciseconds === null,
    diffDeciseconds,
  };
}
