import { ArrowRight, ShieldCheck } from "lucide-react";

import { href } from "../../nav/useNav";
import { NETWORK_LABEL, NETWORK_TRUST_LABEL } from "../../config/contracts";

/**
 * The landing page.
 *
 * Written for someone who has never heard of Aqua, SwapVM or a solver, and who should not have to.
 * The vocabulary is wallets, permission and market makers - every protocol term is either absent or
 * introduced in passing. If a sentence needs the reader to already understand the architecture, it
 * does not belong on this page.
 *
 * The numbers in the figure below are illustrative and labelled as such. Putting fabricated live
 * figures on a page whose entire argument is "we only show you real numbers" would undercut the one
 * claim the product makes.
 */
export function LandingPage() {
  return (
    <div className="landing">
      {/* ---------- hero ---------- */}
      <section className="lp-hero">
        <div className="lp-inner lp-hero-inner">
          <span className="lp-eyebrow">
            <span className="dot" />
            Live on {NETWORK_LABEL}
          </span>

          <h1>
            Trade against liquidity that can <em>actually pay you</em>
          </h1>

          <p className="lp-sub">
            Most venues quote you the amount they&apos;d like to trade. We quote the amount they can
            genuinely deliver this second - checked against real balances before you ever sign.
          </p>

          <div className="lp-cta">
            <a className="btn btn-primary" href={href("swap")}>
              Trade
              <ArrowRight size={16} strokeWidth={2.5} aria-hidden="true" />
            </a>
            <a className="btn" href={href("liquidity")}>
              See live liquidity
            </a>
          </div>

          <div className="lp-trust">
            <span>No sign-up</span>
            <span>Non-custodial</span>
            <span>Settles in one transaction</span>
          </div>

          <GapFigure />
        </div>
      </section>

      {/* ---------- the problem ---------- */}
      <section className="lp-section lp-band">
        <div className="lp-inner">
          <div className="lp-head">
            <span className="label">The problem</span>
            <h2>Some liquidity is a promise, not a balance</h2>
            <p>
              When a venue advertises depth, you assume the money is sitting there waiting. Often it
              isn&apos;t. Here is how a trade fails today:
            </p>
          </div>

          <div className="lp-steps">
            <Step
              title="A market maker offers 100 tokens"
              body="It appears on the venue like any other liquidity. Nothing marks it as different from
              funds held in a pool."
            />
            <Step
              title="But the tokens never left their wallet"
              body="The offer is a permission to spend, not a deposit. The maker still holds the coins and
              can move them, or withdraw that permission, whenever they want - silently, with no
              announcement anyone can see."
            />
            <Step
              title="You find out when your trade fails"
              body="Your order is routed against the full 100. Settlement tries to pull tokens that are no
              longer there and reverts. You've paid gas, waited for a block, and received nothing."
            />
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className="lp-section">
        <div className="lp-inner">
          <div className="lp-head">
            <span className="label">How we fix it</span>
            <h2>We quote what can be paid, not what was promised</h2>
            <p>Three checks stand between you and a failed trade.</p>
          </div>

          <div className="lp-steps">
            <Step
              title="Check the wallet before quoting"
              body="For every source we read what it advertises, what it actually holds, and how much it has
              given permission to spend. Your quote is capped by the smallest of the three - so the
              depth on screen is depth that can settle."
            />
            <Step
              title="Check again before your money moves"
              body="At the moment of settlement the contract re-reads every source. If anything changed since
              your quote, the entire trade is cancelled and returned to you - never partly filled,
              never at a worse price than you agreed."
            />
            <Step
              title="Sources pull back when markets turn"
              body="Each one follows its own published rules: reduce size when volatility spikes, and restore
              it only once calm has genuinely held. You can see which state every source is in, and
              your route reflects it automatically."
            />
          </div>
        </div>
      </section>

      {/* ---------- the guarantee ---------- */}
      <section className="lp-section lp-band">
        <div className="lp-inner">
          <div className="lp-head">
            <span className="label">What this means for you</span>
            <h2>The number you see is the number you can fill</h2>
          </div>

          <div className="lp-promises">
            <div className="lp-promise">
              <h3>Real depth, up front</h3>
              <p>
                Every figure is what could be settled right now. Where a source advertises more than it
                can deliver, we show you both - the inflated number struck through beside the real one.
              </p>
            </div>
            <div className="lp-promise">
              <h3>Cancelled, never half-filled</h3>
              <p>
                If liquidity disappears between your quote and your trade, the whole thing is rejected.
                You keep your tokens. You are never left holding half a position.
              </p>
            </div>
            <div className="lp-promise">
              <h3>You can check our work</h3>
              <p>
                Every quote explains which sources filled it, at what price and why. After settling, you
                can see exactly how the order was split on-chain.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- close ---------- */}
      <section className="lp-section">
        <div className="lp-inner lp-close">
          <ShieldCheck size={28} strokeWidth={1.75} color="var(--accent)" aria-hidden="true" />
          <h2>Ready when you are</h2>
          <p className="lp-sub" style={{ textAlign: "center" }}>
            Connect a wallet, pick an amount, and see the route before you commit to anything.
          </p>
          <div className="lp-cta">
            <a className="btn btn-primary" href={href("swap")}>
              Trade
              <ArrowRight size={16} strokeWidth={2.5} aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <span className="badge badge-net">{NETWORK_TRUST_LABEL}</span>
      </footer>
    </div>
  );
}

function Step({ title, body }: { title: string; body: string }) {
  return (
    <article className="lp-step">
      <div className="lp-step-body">
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </article>
  );
}

/**
 * Advertised versus deliverable, as one picture.
 *
 * Marked as an example rather than dressed up as live data. The figures are the shape of a real
 * shortfall - a maker advertising 100 against a wallet holding 12 - which is the entire thesis in
 * two bars.
 */
function GapFigure() {
  return (
    <figure className="gapfig">
      <div className="gapfig-head">
        <span className="label">Example · a maker with an empty wallet</span>
        <span className="badge badge-bad">
          <span className="dot" />
          88% undeliverable
        </span>
      </div>

      <div className="gapfig-row">
        <span className="k">
          <span className="dim">Advertised</span>
          <b className="dim" style={{ textDecoration: "line-through", textDecorationColor: "var(--bad)" }}>
            100.000
          </b>
        </span>
        <span className="gapfig-track gapfig-ghost">
          <i style={{ width: "100%" }} />
        </span>
      </div>

      <div className="gapfig-row">
        <span className="k">
          <span>Can actually be paid out</span>
          <b style={{ color: "var(--ok)" }}>12.000</b>
        </span>
        <span className="gapfig-track gapfig-real">
          <i style={{ width: "12%" }} />
        </span>
      </div>

      <figcaption className="gapfig-note">
        The maker still shows 100 because that is what they offered. Their wallet holds 12. We quote
        you 12 - and refuse to route the difference.
      </figcaption>
    </figure>
  );
}
