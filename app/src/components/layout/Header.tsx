import { ArrowRight, Waves } from "lucide-react";

import { APP_ROUTES, href, ROUTE_LABELS, useRoute } from "../../nav/useNav";
import { ConnectButton } from "./ConnectButton";

/**
 * Two modes, one header.
 *
 * On the landing page there is no nav and no wallet control - a visitor who has not decided to
 * trade yet should be offered one action, not four, and prompting for a wallet before they know
 * what the product does is how landing pages lose people. Inside the app the nav and wallet
 * controls appear, and the logo becomes the way back out.
 */
export function Header() {
  const route = useRoute();
  const isLanding = route === "home";

  return (
    <header className="topbar">
      <a href={href("home")} className="brand" style={{ textDecoration: "none", color: "inherit" }}>
        <span className="mark">
          <Waves size={13} strokeWidth={2.5} color="var(--accent-ink)" aria-hidden="true" />
        </span>
        <span>Conditional Liquidity</span>
      </a>

      {!isLanding && (
        <nav className="nav" aria-label="Primary">
          {APP_ROUTES.map((r) => (
            <a key={r} href={href(r)} aria-current={route === r ? "page" : undefined}>
              {ROUTE_LABELS[r]}
            </a>
          ))}
        </nav>
      )}

      <span className="spacer" />

      {isLanding ? (
        <a className="btn btn-primary" href={href("swap")}>
          Trade
          <ArrowRight size={15} strokeWidth={2.5} aria-hidden="true" />
        </a>
      ) : (
        <ConnectButton />
      )}
    </header>
  );
}
