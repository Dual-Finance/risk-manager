import { Cluster } from '@solana/web3.js';
import { DIPDeposit, SYMBOL, ScalperMode } from './common';
import {
  OPB_DEVNET_PROGRAM_ID, OPB_MAINNET_PROGRAM_ID, USDC_DEVNET_PK, USDC_MAINNET_PK,
} from './constants';

export const IS_DEV = process.env.DEV !== 'false';
export const API_URL = process.env.RPC;
export const TRADING_ACCOUNT = process.env.WALLET;
export const PRICE_OVERRIDE = Number(process.env.PRICE);
// Priority Fee to use for all txs in micro lamports
export const PRIORITY_FEE = process.env.FEE ? parseInt(process.env.FEE, 10) : 1;

export const CURRENT_SYMBOL = process.env.SYMBOL as SYMBOL;

const DEFAULT_PARAMS = {
  BTC: {symbol: 'BTC', deltaOffset: 0, theoVol: 0.3, zScore: 1.282, mode: ScalperMode.Normal},
  ETH: {symbol: 'ETH', deltaOffset: 0, theoVol: 0.4, zScore: 1.282, mode: ScalperMode.Normal},
  SOL: {symbol: 'SOL', deltaOffset: 0, theoVol: 0.5, zScore: 1.282, mode: ScalperMode.Normal},
  mSOL: {symbol: 'mSOL', deltaOffset: 0, theoVol: 0.3, zScore: 1.282, mode: ScalperMode.Normal},
  jitoSOL: {symbol: 'jitoSOL', deltaOffset: 0, theoVol: 0.3, zScore: 1.282, mode: ScalperMode.Normal},
  MNGO: {symbol: 'MNGO', deltaOffset: 0, theoVol: 0.6, zScore: 1.282, mode: ScalperMode.Normal},
  BONK: {symbol: 'BONK', deltaOffset: 0, theoVol: 1.0, zScore: 2.58, mode: ScalperMode.Normal},
  DUAL: {symbol: 'DUAL', deltaOffset: 0, theoVol: 0.8, zScore: 1.282, mode: ScalperMode.Normal},
};

if (!Object.keys(DEFAULT_PARAMS).includes(CURRENT_SYMBOL)) {
  throw new Error("Invalid symbol");
}

export const DELTA_OFFSET = process.env.DELTA_OFFSET ? parseFloat(process.env.DELTA_OFFSET) : DEFAULT_PARAMS[CURRENT_SYMBOL].deltaOffset;
export const THEO_VOL = process.env.THEO_VOL ? parseFloat(process.env.THEO_VOL) : DEFAULT_PARAMS[CURRENT_SYMBOL].theoVol;
export const Z_SCORE = process.env.Z_SCORE ? parseFloat(process.env.Z_SCORE) : DEFAULT_PARAMS[CURRENT_SYMBOL].zScore;
export const SCALPER_MODE = process.env.SCALPER_MODE ? parseInt(process.env.SCALPER_MODE) as ScalperMode: DEFAULT_PARAMS[CURRENT_SYMBOL].SCALPER_MODE;

export const CLUSTER: Cluster = IS_DEV ? 'devnet' : 'mainnet-beta';
export const DUAL_API = IS_DEV ? 'https://dev.api.dual.finance' : 'https://api.dual.finance';
export const FILLS_URL = IS_DEV ? 'ws://api.mngo.cloud:2082' : 'wss://api.mngo.cloud/fills/v1/';
export const VIAL_WS_URL = 'wss://vial.mngo.cloud/v1/ws';
export const USDC_PK = IS_DEV ? USDC_DEVNET_PK : USDC_MAINNET_PK;
export const OPENBOOK_FORK_ID = IS_DEV ? OPB_DEVNET_PROGRAM_ID : OPB_MAINNET_PROGRAM_ID;

// Products to not bother pulling Jupiter Mid Market Pricing
export const LIQUID_SYMBOLS = ['SOL', 'ETH', 'BTC'];

export const MIN_CONTRACT_SIZE = new Map<SYMBOL, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['mSOL', 0.01], ['jitoSOL', 0.01], ['SOL', 0.01], ['MNGO', 0.01], ['BONK', 1000], ['DUAL', 0.01],
]);

export const MIN_OPENBOOK_SIZE = new Map<SYMBOL, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['mSOL', 0.001], ['jitoSOL', 0.001], ['SOL', 0.001], ['MNGO', 10], ['BONK', 1000], ['DUAL', 1],
]);

export const TICK_SIZE = new Map<SYMBOL, number>([
  ['BTC', 0.1], ['ETH', 0.1], ['mSOL', 0.001], ['jitoSOL', 0.001], ['SOL', 0.001], ['MNGO', 0.000001], ['BONK', 0.000000001], ['DUAL', 0.000001],
]);

export const MAX_NOTIONAL = new Map<SYMBOL, number>([
  ['BTC', 20000], ['ETH', 10000], ['mSOL', 5000], ['jitoSOL', 5000], ['SOL', 10000], ['MNGO', 2500], ['BONK', 100], ['DUAL', 1000],
]); // Max hedging $ notional sizes

export const SLIPPAGE_MAX = new Map<SYMBOL, number>([
  ['BTC', 0.0005], ['ETH', 0.0005], ['mSOL', 0.0015], ['jitoSOL', 0.0015], ['SOL', 0.0010], ['MNGO', 0.0015], ['BONK', 0.0005], ['DUAL', 0.0015],
]); // Max Allowed xbps above/below FMV on limit orders

export const BVE_VOL_MAP = new Map<SYMBOL, number>([
  ['BTC', 0.2], ['ETH', 0.25], ['mSOL', 0], ['jitoSOL', 0], ['SOL', 0.3], ['MNGO', 0.35], ['BONK', 0.35], ['DUAL', 0.35],
]); // BVE vol keep alligned with app & contract vol

// TODO: Pull all these rates from an external source
// Risk Free Rate of Return ~ 3mo T-Bill Rate
export const RF_RATE = 0.05;

export const STAKE_RATE_MAP = new Map<SYMBOL, number>([
  ['BTC', 0], ['ETH', 0.045], ['mSOL', 0], ['jitoSOL', 0], ['SOL', 0.07], ['MNGO', 0], ['BONK', 0], ['DUAL', 0], ['USDC', RF_RATE],
]); // Staking Rate can be considered the risk-free rate for each token

export const INFLATION_MAP = new Map<SYMBOL, number>([
  ['BTC', 0.017], ['ETH', 0.008], ['mSOL', 0], ['jitoSOL', 0], ['SOL', 0.06325], ['MNGO', 0.1], ['BONK', 0.1], ['DUAL', 0.15], ['USDC', 0.04],
]); // Estimated rates of inflation for each token

export const STORAGE_RATE_MAP = new Map<SYMBOL, number>([
  ['BTC', 0.0005], ['ETH', 0.0005], ['mSOL', 0.0005], ['jitoSOL', 0.0005], ['SOL', 0.0005], ['MNGO', 0.0005], ['BONK', 0.0005], ['DUAL', 0.0005], ['USDC', 0],
]); // Storage cost factors in hardware wallet or custody provider fees and zero bank fee USDC = USD

export const ELIGIBLE_SO_STATES: {symbol: SYMBOL, name: string}[] = [
  { symbol: 'BONK', name: 'GSOBONK_LOYALTY_13'},
  { symbol: 'BONK', name: 'GSOBONK_LOYALTY_12'},
  { symbol: 'MNGO', name: 'MNGO Buyback 10'},
  { symbol: 'MNGO', name: 'MNGO Buyback 9'},
];

// TODO: Include these in an env file
// Enter any Staking Options owned and to be hedged from the treasury
export const TREASURY_POSITIONS: DIPDeposit[] = [];

// Amount to vary the sleep on a random sleep.
export const RANDOM_SLEEP_MULTIPLIER = 0.05;
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
export const BACK_GAMMA_SPREAD_RATIO = 0.8;
// IV spread market maker at minimum must beat backstop to take fills
export const VOL_SPREAD = 0.05;
// Max % spread to allow whale bid/ask
export const WHALE_MAX_SPREAD = 0.4;
// How frequently to poll for fills
export const RESOLVE_PERIOD_MS = 100;
// Order size buffer in percent to use to reduce order sizes
export const ORDER_SIZE_BUFFER_PCT = 0.99;
// Time in secs to allow loading of price
export const MAX_LOAD_TIME = 30;
// Number of times to optimstically route to MM
export const MAX_ROUTE_ATTEMPTS = 10;
// Time to wait for MM to refresh bids
export const MM_REFRESH_TIME = 5;
// No routed size
export const NO_ROUTED_SIZE = 0;
// Max Staleness to Allow Oracle Updates in Seconds
export const MAX_STALENESS = 400;
