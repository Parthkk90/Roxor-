import { coverageBand, coverageMeaning, coverageTone, type CoverageBand } from "../../market/coverage";

const TONE_VAR: Record<ReturnType<typeof coverageTone>, string> = {
  success: "var(--ok)",
  warning: "var(--warn)",
  danger: "var(--bad)",
  neutral: "var(--text-faint)",
};

export const BAND_WORD: Record<CoverageBand, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  FRAGILE: "Fragile",
  UNRELIABLE: "Unreliable",
};

export function bandColor(band: CoverageBand): string {
  return TONE_VAR[coverageTone(band)];
}

/**
 * Coverage: the share of advertised depth that can actually be settled.
 *
 * Always rendered as a percentage, a band *word* and a bar together. Colour alone carries no
 * meaning here - the previous build encoded the entire reliability signal in the hue of a small
 * dot, which put it out of reach of anyone who could not separate those hues.
 */
export function CoverageIndicator({
  bps,
  size = "md",
  explain = false,
}: {
  bps: number | undefined;
  size?: "sm" | "md" | "lg";
  explain?: boolean;
}) {
  if (bps === undefined) {
    return (
      <div className="cov">
        <div className="cov-top">
          <span className={`cov-pct cov-pct-${size}`}>-</span>
        </div>
        <p className="cov-note">Coverage can&apos;t be read right now.</p>
      </div>
    );
  }

  const band = coverageBand(bps);
  const pct = Math.min(100, bps / 100);

  return (
    <div className="cov">
      <div className="cov-top">
        <span className={`cov-pct cov-pct-${size}`} style={{ color: bandColor(band) }}>
          {pct.toFixed(0)}%
        </span>
        <span className="badge" style={{ color: bandColor(band), borderColor: "currentColor" }}>
          {BAND_WORD[band]}
        </span>
      </div>

      <div
        className="cov-track"
        role="img"
        aria-label={`${pct.toFixed(0)} percent of advertised liquidity is executable - ${BAND_WORD[band]}`}
      >
        <i style={{ width: `${pct}%`, background: bandColor(band) }} />
      </div>

      {explain && (
        <p className="cov-note">
          {pct.toFixed(0)}% of advertised liquidity is currently executable. {coverageMeaning(band)}
        </p>
      )}
    </div>
  );
}
