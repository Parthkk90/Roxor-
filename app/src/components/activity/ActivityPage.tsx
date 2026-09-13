import { ExternalLink, History, TriangleAlert } from "lucide-react";

import { useActivity, type ActivityRecord } from "../../activity/useActivity";
import { useMarket } from "../../market/useMarket";
import { useTradePair } from "../../trade/useTrade";
import { shortHash, txUrl } from "../../chain/explorer";
import { fmt } from "../../format";

/**
 * Settled trades, with the split that actually executed.
 *
 * Everywhere else in the app a route is a forecast. Here it is a fact: these are the legs the
 * Solver emitted on settlement, so this is the only screen that can say where flow *went* rather
 * than where it was expected to go.
 */
export function ActivityPage() {
  const pair = useTradePair();
  const activity = useActivity();
  const market = useMarket(pair.tokenIn.address, pair.tokenOut.address, pair.market.aquaVenue, pair.market.uniswapV4Venue);

  const venueName = (address: string) =>
    market.sources.find((s) => s.address.toLowerCase() === address.toLowerCase())?.name ??
    shortHash(address);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Activity</h1>
        <p>Recent settlements and how each order was split across sources.</p>
      </div>

      {!activity.configured ? (
        <div className="state">
          <span className="glyph">
            <History size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          <h3>History isn&apos;t connected</h3>
          <p>
            Trade history comes from an index that isn&apos;t configured for this deployment. Swapping
            works normally - every figure on the swap screen is read straight from the chain.
          </p>
        </div>
      ) : activity.isError ? (
        <div className="notice notice-bad">
          <TriangleAlert size={16} aria-hidden="true" />
          <div>
            <strong>Couldn&apos;t load history</strong>
            <p>
              The index didn&apos;t respond.{" "}
              <button
                className="btn btn-ghost"
                style={{ minHeight: 0, padding: 0, color: "var(--accent)" }}
                onClick={activity.refetch}
              >
                Retry
              </button>
            </p>
          </div>
        </div>
      ) : activity.isLoading ? (
        <div className="activity">
          {[0, 1, 2].map((i) => (
            <div className="act-row" key={i}>
              <div className="act-main">
                <span className="skeleton" style={{ height: 20, width: "55%" }} />
                <span className="skeleton" style={{ height: 14, width: "35%" }} />
              </div>
            </div>
          ))}
        </div>
      ) : activity.records.length === 0 ? (
        <div className="state">
          <span className="glyph">
            <History size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          <h3>No settlements yet</h3>
          <p>Completed swaps will appear here with the route each one actually took.</p>
        </div>
      ) : (
        <div className="activity">
          {activity.records.map((record) => (
            <Row key={record.id} record={record} venueName={venueName} symbolIn={pair.tokenIn.symbol} symbolOut={pair.tokenOut.symbol} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  record,
  venueName,
  symbolIn,
  symbolOut,
}: {
  record: ActivityRecord;
  venueName: (address: string) => string;
  symbolIn: string;
  symbolOut: string;
}) {
  const url = txUrl(record.txHash);
  const total = record.legs.reduce((sum, leg) => sum + leg.amountIn, 0n);

  return (
    <div className="act-row">
      <div className="act-main">
        <span className="act-pair">
          {fmt(record.totalAmountIn, 4)} {symbolIn}
          <span className="faint" aria-hidden="true">→</span>
          {fmt(record.totalAmountOut, 4)} {symbolOut}
        </span>

        <span style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {record.legs.map((leg, i) => (
            <span className="route-key" key={leg.id}>
              <i style={{ background: ["var(--accent)", "var(--info)", "var(--ok)"][i % 3] }} />
              <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
                {venueName(leg.venue)} {total === 0n ? 0 : Number((leg.amountIn * 100n) / total)}%
              </span>
            </span>
          ))}
        </span>
      </div>

      <div className="act-side">
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          {new Date(record.timestamp * 1000).toLocaleString()}
        </span>
        {url ? (
          <a className="txlink" href={url} target="_blank" rel="noreferrer">
            {shortHash(record.txHash)}
            <ExternalLink size={11} strokeWidth={2.5} aria-hidden="true" />
          </a>
        ) : (
          <span className="txlink">{shortHash(record.txHash)}</span>
        )}
      </div>
    </div>
  );
}
