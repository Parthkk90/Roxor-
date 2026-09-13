/**
 * Every transaction this deployment sent to Ethereum Sepolia, in the order it was sent.
 *
 * One list, two consumers: `tx-table.mjs` renders it into `docs/sepolia-deployment.md` and
 * `manifest.mjs` writes it into `deployments/11155111.json`. Both fetch each receipt from chain
 * rather than trusting anything recorded here beyond the hash itself.
 */
export const TRANSACTIONS = [
  ["Deploy AquaVenue", "0x6dfdcebb3c7d207ef4a2d7465e215bd95ec2ccf64ecceec511a9222df21e52c5"],
  ["Deploy ConditionalLiquidityHook (CREATE2, mined)", "0x586e8f84d75baaef4f350e008332bc889bb344fbcf087309acefd02c04356f66"],
  ["PoolManager.initialize (Uniswap's own Sepolia manager)", "0x192bfae1197318e90acc6214aefc7f6b0b87d3259ff0baeab7007f61d3e80bef"],
  ["Hook.registerPoolStrategy (binds the existing strategy to the new pool)", "0x6a6b2e211a30333684aded100593817e9a3fa1ff15e9f37787c9edf77024485e"],
  ["Mint 25 DTB to fund the pool position", "0x7eeaa19aab6b1c58d21a7d3dbfd10f2f71cac04f871023301e93b06360f74c5e"],
  ["Mint 25 DTA to fund the pool position", "0xf3f4ff56939ddd7a805478c7de648a766262db1a7cd922180a4764c09a4a8f67"],
  ["Approve DTB to the v4 liquidity router", "0xbc056129adad57374e2a2ddd3e137f37c65b3aedb08188bf9586223092dc9601"],
  ["Approve DTA to the v4 liquidity router", "0xab75e94a2441278615615e808d8a91ab6f9e20017b2faddf74db677af6644c56"],
  ["Add full-range liquidity (20e18)", "0xe6f8b2db62f3acf617546d589d9dc861ccbd2bafa26579e542fa313eee734086"],
  ["Deploy UniswapV4Venue", "0xb04ef42493c4d4b31782630d386c828437e78f4d17f1299ffcf6791c4b811c89"],
  ["Deploy Solver", "0x27e638535920b8ff69ee5d749cfee2f63edde3b09ab3c939296da0d49a90e1f7"],
  ["Fund the trader account with 0.01 ETH", "0xeaef5a62424c8c255c43970e39baefa50d608e3f9fd570334965f653f055a0e0"],
  ["Trim the maker's DTB wallet to 4 (makes the solvency bound bind)", "0x960c2a208790c77a45f92b24dfe33d74ec0a03f119930f876f39fb5c2bd514b3"],
  ["Trim the maker's DTA wallet to 200", "0x9ce8bf3694cb50e263646ea6a7e9ff2e8b442a9226f00c115602dff3e2a2f61a"],
  ["Mint 6 DTB to the trader", "0xfd32d294dec12b77df0c49340dfd1e0d377362e9ae03ff48e0a21445219187dd"],
  ["Trader approves the Solver for 5 DTB", "0x37ddbc19db4e7e4fa5db5146fc901e29aaf784abe218f564725d6373d6b04468"],
  ["REAL SWAP: Solver.settle, 5 DTB -> 6.708 DTA across both venues", "0xb55c0a7d792fecc4ef264620022574737448f5621237ad78b282abec67272009"],
  ["Oracle: volatility 65% (shock)", "0x061caccfec374cd59230e48be87f679751f121486cb345d1eb345347d36a9346"],
  ["Engine.poke -> NORMAL to DEFENSIVE", "0xd64095a11d83f9a36e29838c5c31ce9973adc08e8b0929c3e7048a6caf8a81d7"],
  ["Oracle: volatility 24% (calm)", "0x55ee3690865caef0b8481aa3524d05e49f81d2d2a4e472bca9c49df36157e988"],
  ["Engine.poke -> arms the 10-minute calm gate", "0x9c9123189ac67a4c8bbb70147f17e00d1c7210e6c02e611caffb4dcea5975b74"],
  ["Engine.poke -> DEFENSIVE to RECOVERY (after 10 minutes of calm)", "0x8ba966ad034d13db0895ad482c63537054e551749d34c27b85277bc98fca28ec"],
  ["Engine.poke -> RECOVERY to NORMAL (after 10 more minutes)", "0xaabc3f66e4427e0f88624f29adfa11c0f7141c4bc4c1d8802ae74f271a8b6bba"],
  [
    "Strategy registered from the frontend's builder path (a second maker, their own thresholds)",
    "0x244d24d0462b2dabb88599cf95fb53aebd16686852fcd43bc257bedcab4b665d",
  ],
  // Frontend verification pass: the shock/calm cycle used to check that the UI reads a regime
  // change live rather than being told about one.
  ["UI check: volatility 65% (shock)", "0x1dd556a0e91434722b8c031ff6604e9b27f1e0f99d240c9e9fdc9bd033c13f74"],
  ["UI check: volatility 24%", "0xcbf45dc412b92bce4785a65cd5c368a9c8c77234b498f25d4a71c5721aa04f4a"],
  ["UI check: volatility 65% (shock)", "0x707f29137d8d98891d9e40583ba12026daf36b14b493ba439a31506f716ede0b"],
  ["UI check: volatility 20% (restored to calm)", "0x1abc061cef80f54ea20ddad9ee9170c2622bf6a3f5a178e1b2486ff71ff9491c"],
];
