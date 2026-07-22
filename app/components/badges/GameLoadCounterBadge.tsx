"use client";

/**
 * Global "games analysed" counter.
 *
 * The counter was backed by a Firestore document behind `/api/metrics/game-load`,
 * which was removed with the rest of Firebase. There is no server datastore to
 * count against anymore, so the hook returns an empty label and the badges
 * render nothing. The consuming components already guard on a truthy label, so
 * the feature simply disappears from the UI without further changes.
 *
 * The hook signature and the badge components are kept so a future counter (e.g.
 * backed by a self-hosted store) can be dropped in here alone.
 */
export function useGameLoadCounterLabel(_loadedGameId?: string | null): {
  gamesLoaded: number | null;
  isLoading: boolean;
  hasError: boolean;
  label: string;
} {
  return { gamesLoaded: null, isLoading: false, hasError: false, label: "" };
}

export function GameLoadCounterFloating({ label }: { label: string }) {
  if (!label) return null;
  return (
    <div className="fixed bottom-3 right-3 z-50 select-none">
      <div className="rounded-md bg-gray-900/85 px-3 py-2 text-xs text-gray-200 shadow-lg backdrop-blur">
        <span className="font-mono tabular-nums">{label}</span>
      </div>
    </div>
  );
}

export function GameLoadCounterInline({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  if (!label) return null;
  return (
    <span className={["font-mono tabular-nums", className ?? ""].join(" ").trim()}>
      {label}
    </span>
  );
}

export function GameLoadCounterBadge({
  loadedGameId,
}: {
  loadedGameId?: string | null;
}) {
  const { label } = useGameLoadCounterLabel(loadedGameId);

  return <GameLoadCounterFloating label={label} />;
}
