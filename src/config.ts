import { Cluster } from '@solana/web3.js';
import { CallOrPut, DIPDeposit, SYMBOL } from './common';
import {
  OPB_DEVNET_PROGRAM_ID, OPB_MAINNET_PROGRAM_ID, USDC_DEVNET_PK, USDC_MAINNET_PK,
} from './constants';

export const IS_DEV = process.env.DEV !== 'false';
export const API_URL = process.env.RPC;
export const TRADING_ACCOUNT = process.env.WALLET;
export const PRICE_OVERRIDE = Number(process.env.PRICE);
// Priority Fee to use for all txs in micro lamports
export const PRIORITY_FEE = process.env.FEE ? parseInt(process.env.FEE, 10) : 1;
const solVars = process.env.SOL ? process.env.SOL.split(',') : [null, null, null, null];
const btcVars = process.env.BTC ? process.env.BTC.split(',') : [null, null, null, null];
const ethVars = process.env.ETH ? process.env.ETH.split(',') : [null, null, null, null];
const mngoVars = process.env.MNGO ? process.env.MNGO.split(',') : [null, null, null, null];
const bonkVars = process.env.BONK ? process.env.BONK.split(',') : [null, null, null, null];
const dualVars = process.env.DUAL ? process.env.DUAL.split(',') : [null, null, null, null];

export const productStatus = new Map<SYMBOL, boolean>([
  ['BTC', btcVars[0] === 'ON'],
  ['ETH', ethVars[0] === 'ON'],
  ['SOL', solVars[0] === 'ON'],
  ['MNGO', mngoVars[0] === 'ON'],
  ['BONK', bonkVars[0] === 'ON'],
  ['DUAL', dualVars[0] === 'ON'],
]);
// Adjust delta hedges for loans, negative values allow positive spot balances in mango
// CAUTION! Turn off scalper, send funds to mango & update value before running!
export const DELTA_OFFSET = new Map<SYMBOL, number>([
  ['BTC', btcVars[1] == null ? 0 : parseFloat(btcVars[1])],
  ['ETH', ethVars[1] == null ? 0 : parseFloat(ethVars[1])],
  ['SOL', solVars[1] == null ? 0 : parseFloat(solVars[1])],
  ['MNGO', mngoVars[1] == null ? 0 : parseFloat(mngoVars[1])],
  ['BONK', bonkVars[1] == null ? 0 : parseFloat(bonkVars[1])],
  ['DUAL', dualVars[1] == null ? 0 : parseFloat(dualVars[1])],
]);

export const THEO_VOL_MAP = new Map<SYMBOL, number>([
  ['BTC', parseFloat(btcVars[2]) > 0 ? parseFloat(btcVars[2]) : 0.3],
  ['ETH', parseFloat(ethVars[2]) > 0 ? parseFloat(ethVars[2]) : 0.4],
  ['SOL', parseFloat(solVars[2]) > 0 ? parseFloat(solVars[2]) : 0.5],
  ['MNGO', parseFloat(mngoVars[2]) > 0 ? parseFloat(mngoVars[2]) : 0.6],
  ['BONK', parseFloat(bonkVars[2]) > 0 ? parseFloat(bonkVars[2]) : 1],
  ['DUAL', parseFloat(dualVars[2]) > 0 ? parseFloat(dualVars[2]) : 0.8],
]); // Defaults to system wide BVE, should be run at realistic IV estimate for best hedging

export const ZSCORE = new Map<SYMBOL, number>([
  ['BTC', parseFloat(btcVars[3]) > 0 ? parseFloat(btcVars[3]) : 1.282],
  ['ETH', parseFloat(ethVars[3]) > 0 ? parseFloat(ethVars[3]) : 1.282],
  ['SOL', parseFloat(solVars[3]) > 0 ? parseFloat(solVars[3]) : 1.282],
  ['MNGO', parseFloat(mngoVars[3]) > 0 ? parseFloat(mngoVars[3]) : 1.282],
  ['BONK', parseFloat(bonkVars[3]) > 0 ? parseFloat(bonkVars[3]) : 2.58],
  ['DUAL', parseFloat(dualVars[3]) > 0 ? parseFloat(dualVars[3]) : 1.282],
]); // Corresponds to 80% CI by default

export enum ScalperMode {
  Normal,
  GammaBack,
  GammaBackStrikeAdjustment,
  BackOnly,
  Perp,
}

export enum HedgeProduct {
  Spot = '-SPOT',
  Perp = '-PERP',
}

export enum HedgeSide {
  buy = 'buy',
  sell = 'sell',
}

export const MODE_BY_SYMBOL = new Map<SYMBOL, ScalperMode>([
  ['BTC', parseFloat(btcVars[4]) > 0 && parseFloat(btcVars[4]) < 5 ? parseFloat(btcVars[4]) : ScalperMode.Normal],
  ['ETH', parseFloat(ethVars[4]) > 0 && parseFloat(ethVars[4]) < 5 ? parseFloat(ethVars[4]) : ScalperMode.Normal],
  ['SOL', parseFloat(solVars[4]) > 0 && parseFloat(solVars[4]) < 5 ? parseFloat(solVars[4]) : ScalperMode.Normal],
  ['MNGO', parseFloat(mngoVars[4]) > 0 && parseFloat(mngoVars[4]) < 5 ? parseFloat(mngoVars[4]) : ScalperMode.Normal],
  ['BONK', parseFloat(bonkVars[4]) > 0 && parseFloat(bonkVars[4]) < 5 ? parseFloat(bonkVars[4]) : ScalperMode.Normal],
  ['DUAL', parseFloat(dualVars[4]) > 0 && parseFloat(dualVars[4]) < 5 ? parseFloat(dualVars[4]) : ScalperMode.Normal],
]);

export const CLUSTER: Cluster = IS_DEV ? 'devnet' : 'mainnet-beta';
export const DUAL_API = IS_DEV ? 'https://dev.api.dual.finance' : 'https://api.dual.finance';
export const FILLS_URL = IS_DEV ? 'ws://api.mngo.cloud:2082' : 'wss://api.mngo.cloud/fills/v1/';
export const VIAL_WS_URL = 'wss://vial.mngo.cloud/v1/ws';
export const usdcPk = IS_DEV ? USDC_DEVNET_PK : USDC_MAINNET_PK;
export const OPENBOOK_FORK_ID = IS_DEV ? OPB_DEVNET_PROGRAM_ID : OPB_MAINNET_PROGRAM_ID;

export const MinContractSize = new Map<SYMBOL, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.01], ['MNGO', 0.01], ['BONK', 1000], ['DUAL', 0.01],
]);

export const MinOpenBookSize = new Map<SYMBOL, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.001], ['MNGO', 10], ['BONK', 1000], ['DUAL', 1],
]);

export const TickSize = new Map<SYMBOL, number>([
  ['BTC', 0.1], ['ETH', 0.1], ['SOL', 0.001], ['MNGO', 0.000001], ['BONK', 0.000000001], ['DUAL', 0.000001],
]);

export const maxNotional = new Map<SYMBOL, number>([
  ['BTC', 20000], ['ETH', 10000], ['SOL', 10000], ['MNGO', 2500], ['BONK', 100], ['DUAL', 1000],
]); // Max hedging $ notional sizes

export const slippageMax = new Map<SYMBOL, number>([
  ['BTC', 0.0005], ['ETH', 0.0005], ['SOL', 0.0010], ['MNGO', 0.0015], ['BONK', 0.0005], ['DUAL', 0.0015],
]); // Max Allowed xbps above/below FMV on limit orders

export const BVE_VOL_MAP = new Map<SYMBOL, number>([
  ['BTC', 0.2], ['ETH', 0.25], ['SOL', 0.3], ['MNGO', 0.35], ['BONK', 0.35], ['DUAL', 0.35],
]); // BVE vol keep alligned with app & contract vol

// Enter any Staking Options owned and to be hedged from the treasury
export const treasuryPositions: DIPDeposit[] = [({
  splTokenName: 'MNGO',
  premiumAssetName: 'USDC',
  expirationMs: 1682942400000,
  strikeUsdcPerToken: 0.018,
  callOrPut: CallOrPut.Put,
  qtyTokens: 6944444,
}),
({
  splTokenName: 'MNGO',
  premiumAssetName: 'USDC',
  expirationMs: 1680350400000,
  strikeUsdcPerToken: 0.020,
  callOrPut: CallOrPut.Put,
  qtyTokens: 12500000,
}),
({
  splTokenName: 'BONK',
  premiumAssetName: 'USDC',
  expirationMs: 1679572800000,
  strikeUsdcPerToken: 0.0000009,
  callOrPut: CallOrPut.Call,
  qtyTokens: 335284600,
}), // BONK GSO Position
({
  splTokenName: 'BTC',
  premiumAssetName: 'USDC',
  expirationMs: 1680350400000,
  strikeUsdcPerToken: 22000,
  callOrPut: CallOrPut.Call,
  qtyTokens: 0.007,
}),
({
  splTokenName: 'BTC',
  premiumAssetName: 'USDC',
  expirationMs: 1680350400000,
  strikeUsdcPerToken: 22000,
  callOrPut: CallOrPut.Put,
  qtyTokens: 0.007,
}), // Test for Mango Perps
({
  splTokenName: 'DUAL',
  premiumAssetName: 'USDC',
  expirationMs: 1685793600000,
  strikeUsdcPerToken: 0.032,
  callOrPut: CallOrPut.Call,
  qtyTokens: 246710,
}),
({
  splTokenName: 'DUAL',
  premiumAssetName: 'USDC',
  expirationMs: 1685793600000,
  strikeUsdcPerToken: 0.032,
  callOrPut: CallOrPut.Put,
  qtyTokens: 246710,
}), // MM around DUAL Straddle
];

// Amount to vary the sleep on a random sleep.
export const RANDOM_SLEEP_MULTIPLIER = 0.05;
// Risk Free Rate of Return ~ T-Bill Rate
export const RF_RATE = 0.03;
// Number of seconds to space spliced delta orders across
export const TWAP_INTERVAL_SEC = 15;
// Number of seconds for each gamma scalping window
export const SCALPER_WINDOW_SEC = 600;
// Percentage of gamma to calc delta hedge threshold
export const GAMMA_THRESHOLD = 0.05;
// Maximum amount of orders to delta hedge across
export const MAX_DELTA_HEDGES = 4;
// Number cycles to scalp gamma
export const GAMMA_CYCLES: number = 10;
// Seconds to wait between reruns of each product
export const PRODUCT_STAGGER_SEC = 30;
// Time in minutes of downtime to stop routing transactions to mango
export const MANGO_DOWNTIME_THRESHOLD_MIN = 15;
// % Funding to switch to openbook orders instead of mango
export const PERP_FUNDING_RATE_THRESHOLD = 0.25;
// Max % allowable spread to use midvalue as accurate price
export const MAX_MKT_SPREAD_PCT_FOR_PRICING = 0.01;
// Move on to new gamma cycle when 90% filled
export const GAMMA_COMPLETE_THRESHOLD_PCT = 0.90;
// Number of times to reduce the jupiter qty to check for routes
export const JUPITER_SEARCH_STEPS = 5;
// Min USDC amount to fill MM on
export const MIN_EXECUTION_PREMIUM = 0.001;
// USDC amount to check jupiter mid point price
export const JUPITER_LIQUIDITY = 100;
// Bps to allow calculating mid price to succeed
export const JUPITER_SLIPPAGE_BPS = 50;
// Max num of levels to search for order book depth
export const MAX_ORDER_BOOK_SEARCH_DEPTH = 100;
// Max multiple of gamma to allow on the back bids
export const MAX_BACK_GAMMA_MULTIPLE = 3;
// Percent random spread around MAX_BACK_GAMMA_MULTIPLE
export const BACK_GAMMA_SPREAD_PRECENT = 0.8;
// IV spread market maker at minimum must beat backstop to take fills
export const VOL_SPREAD = 0.05;
// Max % spread to allow whale bid/ask
export const WHALE_MAX_SPREAD = 0.4;
// How frequently to poll for fills
export const RESOLVE_PERIOD_MS = 100;
// Order size buffer in percent to use to reduce order sizes
export const ORDER_SIZE_BUFFER_PCT = 0.99;
