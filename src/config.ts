import { Cluster } from '@solana/web3.js';
import { CallOrPut, DIPDeposit, SYMBOL } from './common';
import {
  openbookDevnetId, openbookMainnetId, usdcDevnetPk, usdcMainnetPk,
} from './constants';

export const IS_DEV = process.env.DEV !== 'false';
export const API_URL = process.env.RPC;
// Priority Fee to use for all txs in micro lamports
export const PRIORITY_FEE = parseInt(process.env.FEE, 10);
const solVars = process.env.SOL.split(',');
const btcVars = process.env.BTC.split(',');
const ethVars = process.env.ETH.split(',');
const mngoVars = process.env.MNGO.split(',');
const bonkVars = process.env.BONK.split(',');

export const productStatus = new Map<SYMBOL, boolean>([
  ['BTC', btcVars[0] === 'ON'],
  ['ETH', ethVars[0] === 'ON'],
  ['SOL', solVars[0] === 'ON'],
  ['MNGO', mngoVars[0] === 'ON'],
  ['BONK', bonkVars[0] === 'ON'],
]);
// Adjust delta hedges for loans, negative values allow positive spot balances in mango
// CAUTION! Turn off scalper, send funds to mango & update value before running!
export const DELTA_OFFSET = new Map<SYMBOL, number>([
  ['BTC', btcVars[1] == null ? 0 : parseFloat(btcVars[1])],
  ['ETH', ethVars[1] == null ? 0 : parseFloat(ethVars[1])],
  ['SOL', solVars[1] == null ? 0 : parseFloat(solVars[1])],
  ['MNGO', mngoVars[1] == null ? 0 : parseFloat(mngoVars[1])],
  ['BONK', bonkVars[1] == null ? 0 : parseFloat(bonkVars[1])],
]);

export const THEO_VOL_MAP = new Map<SYMBOL, number>([
  ['BTC', parseFloat(btcVars[2]) > 0 ? parseFloat(btcVars[2]) : 0.3],
  ['ETH', parseFloat(ethVars[2]) > 0 ? parseFloat(ethVars[2]) : 0.4],
  ['SOL', parseFloat(solVars[2]) > 0 ? parseFloat(solVars[2]) : 0.5],
  ['MNGO', parseFloat(mngoVars[2]) > 0 ? parseFloat(mngoVars[2]) : 0.6],
  ['BONK', parseFloat(bonkVars[2]) > 0 ? parseFloat(bonkVars[2]) : 1],
]); // Defaults to system wide BVE, should be run at realistic IV estimate for best hedging

export const ZSCORE = new Map<SYMBOL, number>([
  ['BTC', parseFloat(btcVars[3]) > 0 ? parseFloat(btcVars[3]) : 1.282],
  ['ETH', parseFloat(ethVars[3]) > 0 ? parseFloat(ethVars[3]) : 1.282],
  ['SOL', parseFloat(solVars[3]) > 0 ? parseFloat(solVars[3]) : 1.282],
  ['MNGO', parseFloat(mngoVars[3]) > 0 ? parseFloat(mngoVars[3]) : 1.282],
  ['BONK', parseFloat(bonkVars[3]) > 0 ? parseFloat(bonkVars[3]) : 2.58],
]); // Corresponds to 80% CI by default

// TODO: Make enum
export const MODE = new Map<SYMBOL, number>([
  ['BTC', parseFloat(btcVars[4]) > 0 ? parseFloat(btcVars[4]) : 0],
  ['ETH', parseFloat(ethVars[4]) > 0 ? parseFloat(ethVars[4]) : 0],
  ['SOL', parseFloat(solVars[4]) > 0 ? parseFloat(solVars[4]) : 0],
  ['MNGO', parseFloat(mngoVars[4]) > 0 ? parseFloat(mngoVars[4]) : 0],
  ['BONK', parseFloat(bonkVars[4]) > 0 ? parseFloat(bonkVars[4]) : 0],
]); // 0 - Normal 1 - Gamma+Back 2 - Gamma+Back w/ Strike Adjustment 3- Back Only

export const ENVIRONMENT: string = IS_DEV ? 'DEVNET' : 'MAINNET';

export const networkName = IS_DEV ? 'devnet.2' : 'mainnet.1';
export const cluster: Cluster = IS_DEV ? 'devnet' : 'mainnet-beta';
export const DUAL_API = IS_DEV ? 'https://dev.api.dual.finance' : 'https://api.dual.finance';
export const FILLS_URL = IS_DEV ? 'ws://api.mngo.cloud:2082' : 'ws://v3.mngo.cloud:8080';
export const VIAL_WS_URL = 'wss://vial.mngo.cloud/v1/ws';
export const usdcPk = IS_DEV ? usdcDevnetPk : usdcMainnetPk;
export const OPENBOOK_FORK_ID = IS_DEV ? openbookDevnetId : openbookMainnetId;

export const ACCOUNT_MAP = new Map<SYMBOL, string>([
  ['BTC', '79ee6JPqTPUDzX4FeAWSntFatmpb5BY5LQrXzMX3aAE6'], ['ETH', 'F7qSsLofbpZBfZ11wkajX9JPshSEeyGpaFvDeuur2mNW'],
  ['SOL', '9EaYbxzU1YJwJojKsKp3U38PBy5aqcN2KS9Xc8hAxZB7'], ['USDC', '2gyJ4SZyQtUEXCLRa459nbWaFzuN8uvyoUsVb7xmpkh1'],
  ['MNGO', '4zzgXnhfwdtASw9JugEyrPSKzvaN8i2WSDm1bnGiHFcK'], ['BONK', 'D8yD6us5X7YNeweppFdBR4idGsyPooetuW2fA6Suabqg'],
]);

export const MinContractSize = new Map<SYMBOL, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.01], ['MNGO', 0.01], ['BONK', 1000],
]);

export const MinOpenBookSize = new Map<SYMBOL, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.001], ['MNGO', 10], ['BONK', 1000],
]);

export const TickSize = new Map<SYMBOL, number>([
  ['BTC', 0.1], ['ETH', 0.1], ['SOL', 0.001], ['MNGO', 0.000001], ['BONK', 0.000000001],
]);

export const maxNotional = new Map<SYMBOL, number>([
  ['BTC', 20000], ['ETH', 10000], ['SOL', 10000], ['MNGO', 2500], ['BONK', 100],
]); // Max hedging $ notional sizes

export const slippageMax = new Map<SYMBOL, number>([
  ['BTC', 0.0005], ['ETH', 0.0005], ['SOL', 0.0010], ['MNGO', 0.0015], ['BONK', 0.0005],
]); // Max Allowed xbps above/below FMV on limit orders

export const BVE_VOL_MAP = new Map<SYMBOL, number>([
  ['BTC', 0.3], ['ETH', 0.4], ['SOL', 0.5], ['MNGO', 0.6], ['BONK', 1.0],
]); // BVE vol keep alligned with app & contract vol

// Enter any Staking Options owned and to be hedged from the treasury
export const treasuryPositions: DIPDeposit[] = [({
  splTokenName: 'MNGO',
  premiumAssetName: 'USDC',
  expirationMs: 1677672000000,
  strikeUsdcPerToken: 0.018,
  callOrPut: CallOrPut.Put,
  qtyTokens: 6944444,
}),
({
  splTokenName: 'MNGO',
  premiumAssetName: 'USDC',
  expirationMs: 1675252800000,
  strikeUsdcPerToken: 0.020,
  callOrPut: CallOrPut.Put,
  qtyTokens: 6250000,
}),
({
  splTokenName: 'BONK',
  premiumAssetName: 'USDC',
  expirationMs: 1675166400000,
  strikeUsdcPerToken: 0.0000005,
  callOrPut: CallOrPut.Call,
  qtyTokens: 10000150,
}), // Actually GSO Position
({
  splTokenName: 'BONK',
  premiumAssetName: 'USDC',
  expirationMs: 1676462400000,
  strikeUsdcPerToken: 0.000003,
  callOrPut: CallOrPut.Call,
  qtyTokens: 10000000,
}), // Running this until EOM
];

// Risk Free Rate of Return ~ T-Bill Rate
export const rfRate = 0.03;
// Number of seconds to space spliced delta orders across
export const twapIntervalSec = 15;
// Number of seconds for each gamma scalping window
export const scalperWindowSec = 600;
// Percentage of gamma to calc delta hedge threshold
export const gammaThreshold = 0.05;
// Maximum amount of orders to delta hedge across
export const maxDeltaHedges = 4;
// Number cycles to scalp gamma
export const gammaCycles: number = 10;
// Seconds to wait between reruns of each product
export const productStaggerSec = 30;
// Time in minutes of downtime to stop routing transactions to mango
export const MANGO_DOWNTIME_THRESHOLD_MIN = 15;
// % Funding to switch to openbook orders instead of mango
export const perpFundingRateThreshold = 0.25;
// Max % allowable spread to use midvalue as accurate price
export const maxMktSpreadPctForPricing = 0.01;
// Move on to new gamma cycle when 90% filled
export const gammaCompleteThresholdPct = 0.90;
// Number of times to reduce the jupiter qty to check for routes
export const jupiterSearchSteps = 5;
// Min USDC amount to fill MM on
export const minExecutionPremium = 0.001;
// USDC amount to check jupiter mid point price
export const JUPITER_LIQUIDITY = 100;
// Bps to allow calculating mid price to succeed
export const jupiterSlippageBps = 50;
// Max num of levels to search for order book depth
export const maxOrderBookSearchDepth = 100;
// Max multiple of gamma to allow on the back bids
export const maxBackGammaMultiple = 5;
// IV spread market maker at minimum must beat backstop to take fills
export const volSpread = 0.05;
// Max % spread to allow whale bid/ask
export const whaleMaxSpread = 0.4;
