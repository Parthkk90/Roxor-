import { useCallback, useSyncExternalStore } from "react";

/**
 * Hash-based navigation, without a router.
 *
 * Four destinations and no nested or parameterised routes, so a routing library would carry far
 * more than this needs. `useSyncExternalStore` over `hashchange` gives real URLs, a working back
 * button and shareable links — which a `useState` tab switcher would not — in about twenty lines.
 */

export const ROUTES = ["home", "swap", "liquidity", "activity"] as const;
export type Route = (typeof ROUTES)[number];

/** The landing page is the entry point: an unexplained swap form is not a product. */
const DEFAULT: Route = "home";

/** The routes that make up the application proper, i.e. what the header nav shows. */
export const APP_ROUTES = ["swap", "liquidity", "activity"] as const satisfies readonly Route[];

function parse(hash: string): Route {
  const name = hash.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : DEFAULT;
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function getSnapshot(): string {
  return window.location.hash;
}

/** The app never renders on a server, but the hook contract requires a server snapshot. */
function getServerSnapshot(): string {
  return "";
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return parse(hash);
}

export function useNavigate() {
  return useCallback((route: Route) => {
    window.location.hash = `/${route}`;
    // A hash change does not reset scroll, so moving between destinations would otherwise land the
    // user mid-page at whatever offset they had scrolled the previous one to.
    window.scrollTo({ top: 0 });
  }, []);
}

export function href(route: Route): string {
  return `#/${route}`;
}

export const ROUTE_LABELS: Record<Route, string> = {
  home: "Home",
  swap: "Swap",
  liquidity: "Liquidity",
  activity: "Activity",
};
