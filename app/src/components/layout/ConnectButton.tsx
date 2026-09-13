import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { LogOut, Wallet } from "lucide-react";

import { chain, chainId as targetChainId } from "../../config/contracts";

/**
 * Wallet control.
 *
 * Privy owns authentication; wagmi owns account and chain state. The two are kept in their own
 * lanes - reading the address from Privy's user object instead of `useAccount` would drift from the
 * account every contract read actually uses.
 *
 * Wrong-network is a friendly, actionable state rather than an error. It names the network the app
 * needs and nothing else - no chain ids, no RPC URLs, no mention of what the wallet is on.
 */
export function ConnectButton() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!ready) {
    return <span className="skeleton" style={{ width: 132, height: 38, borderRadius: "var(--r-md)" }} />;
  }

  if (!authenticated || !isConnected) {
    return (
      <button className="btn btn-primary" onClick={login}>
        <Wallet size={15} strokeWidth={2} aria-hidden="true" />
        Connect wallet
      </button>
    );
  }

  if (connectedChainId !== targetChainId) {
    return (
      <button
        className="btn"
        style={{ borderColor: "var(--warn-line)", background: "var(--warn-wash)", color: "var(--warn)" }}
        onClick={() => switchChain({ chainId: targetChainId })}
        disabled={isPending}
      >
        {isPending ? "Switching…" : `Switch to ${chain.name}`}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span className="badge badge-ok" title={address}>
        <span className="dot" />
        {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Connected"}
      </span>
      <button className="btn btn-ghost" onClick={logout} aria-label="Disconnect wallet" style={{ padding: "0 10px" }}>
        <LogOut size={15} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
