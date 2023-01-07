/* eslint-disable */
import { PublicKey } from '@solana/web3.js';
import { DIPDeposit } from './common';

export const IS_DEV = process.env.DEV != 'false';
export const API_URL = process.env.RPC;
export const sol_vars = process.env.SOL.split(',');
export const btc_vars = process.env.BTC.split(',');
export const eth_vars = process.env.ETH.split(',');
export const mngo_vars = process.env.MNGO.split(',');
export const bonk_vars = process.env.BONK.split(',');

export const productStatus = new Map<string, boolean>([
  ['BTC', btc_vars[0] == 'ON'],
  ['ETH', eth_vars[0] == 'ON'],
  ['SOL', sol_vars[0] == 'ON'],
  ['MNGO', mngo_vars[0] == 'ON'],
  ['BONK', bonk_vars[0] == 'ON'],
]);
// Adjust delta hedges for loans, negative values allow positive spot balances in mango
// CAUTION! Turn off scalper, send funds to mango & update value before running!
export const DELTA_OFFSET = new Map<string, number>([
  ['BTC', btc_vars[1] == null ? 0 : parseFloat(btc_vars[1])],
  ['ETH', eth_vars[1] == null ? 0 : parseFloat(eth_vars[1])],
  ['SOL', sol_vars[1] == null ? 0 : parseFloat(sol_vars[1])],
  ['MNGO', mngo_vars[1] == null ? 0 : parseFloat(mngo_vars[1])],
  ['BONK', bonk_vars[1] == null ? 0 : parseFloat(bonk_vars[1])],
]);

export const THEO_VOL_MAP = new Map<string, number>([
  ['BTC', parseFloat(btc_vars[2]) > 0 ? parseFloat(btc_vars[2]) : 0.60],
  ['ETH', parseFloat(eth_vars[2]) > 0 ? parseFloat(eth_vars[2]) : 0.72],
  ['SOL', parseFloat(sol_vars[2]) > 0 ? parseFloat(sol_vars[2]) : 0.84],
  ['MNGO', parseFloat(mngo_vars[2]) > 0 ? parseFloat(mngo_vars[2]) : 1.6],
  ['BONK', parseFloat(bonk_vars[2]) > 0 ? parseFloat(bonk_vars[2]) : 3],
]);

export const ZSCORE = new Map<string, number>([
  ['BTC', parseFloat(btc_vars[3]) > 0 ? parseFloat(btc_vars[3]) : 1.282],
  ['ETH', parseFloat(eth_vars[3]) > 0 ? parseFloat(eth_vars[3]) : 1.282],
  ['SOL', parseFloat(sol_vars[3]) > 0 ? parseFloat(sol_vars[3]) : 1.282],
  ['MNGO', parseFloat(mngo_vars[3]) > 0 ? parseFloat(mngo_vars[3]) : 1.282],
  ['BONK', parseFloat(bonk_vars[3]) > 0 ? parseFloat(bonk_vars[3]) : 2.58],
]); // Corresponds to 80% CI by default

// TODO make enum
export const MODE = new Map<string, number>([
  ['BTC', parseFloat(btc_vars[4]) > 0 ? parseFloat(btc_vars[4]) : 0],
  ['ETH', parseFloat(eth_vars[4]) > 0 ? parseFloat(eth_vars[4]) : 0],
  ['SOL', parseFloat(sol_vars[4]) > 0 ? parseFloat(sol_vars[4]) : 0],
  ['MNGO', parseFloat(mngo_vars[4]) > 0 ? parseFloat(mngo_vars[4]) : 0],
  ['BONK', parseFloat(bonk_vars[4]) > 0 ? parseFloat(bonk_vars[4]) : 0],
]); // 0 - Normal 1 - Gamma+Back 2- Back Only

export const ENVIRONMENT: string = IS_DEV ? 'DEVNET' : 'MAINNET';

export const networkName = IS_DEV ? 'devnet.2' : 'mainnet.1';
export const cluster = IS_DEV ? 'devnet' : 'mainnet-beta';
export const DUAL_API = IS_DEV ? 'https://dev.api.dual.finance' : 'https://api.dual.finance';
export const FILLS_URL = IS_DEV ? 'ws://api.mngo.cloud:2082' : 'ws://v3.mngo.cloud:8080';
export const usdcMintPk = IS_DEV ? new PublicKey('HJiQv33nKujRmZQ3sJBSosXgCEmiHs3mG1yd9VcLawPM') : new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const settlementWallet = new PublicKey('2qLWeNrV7QkHQvKBoEvXrKeLqEB2ZhscZd4ds7X2JUhn');
export const PROTCOL_API_KEY = '033000e0a1c3a87a4ec58c9ecbc0e41da02fd517e313ec602422a46f5de5dac7';
export const wSOLPk = new PublicKey(
  'So11111111111111111111111111111111111111112',
);
// These are only in mainnet because mango does not support them
export const soBTCPk = new PublicKey(
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
);

export const soETHPk = new PublicKey(
  '2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk',
);

export const mngoPK = new PublicKey(
  'MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac',
);

export const bonkPK = new PublicKey(
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
);

export const dualMarketProgramID = new PublicKey(
  'DiPbvUUJkDhV9jFtQsDFnMEMRJyjW5iS6NMwoySiW8ki',
);
export const optionVaultPk = new PublicKey(
  '9SgZKdeTMaNuEZnhccK2crHxi1grXRmZKQCvNSKgVrCQ',
);
export const riskManagerPk = new PublicKey(
  'FCsXUii28gmnKQCZV1vGMZPqF2LCRCr3pqErQcskgr8W',
);
export const mangoTesterPk = new PublicKey(
  'CkcJx7Uwgxck5zm3DqUp2N1ikkkoPn2wA8zf7oS4tFSZ',
);
export const CHAINLINK_PROGRAM_ID = new PublicKey(
  'cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ',
);
export const OPENBOOK_FORK_ID = IS_DEV ? new PublicKey('EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj')
  : new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');
export const OPENBOOK_MKT_MAP = new Map<string, string>([
  ['SOL', '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'], ['MNGO', '3NnxQvDcZXputNMxaxsGvqiKpqgPfSYXpNigZNFcknmD'],
  ['BONK', '8PhnCfgqpgFM7ZJvttGdBVMXHuU4Q23ACxCvWkbs1M71'],
]);
export const ACCOUNT_MAP = new Map<string, string>([
  ['BTC', '79ee6JPqTPUDzX4FeAWSntFatmpb5BY5LQrXzMX3aAE6'], ['ETH', 'F7qSsLofbpZBfZ11wkajX9JPshSEeyGpaFvDeuur2mNW'],
  ['SOL', '9EaYbxzU1YJwJojKsKp3U38PBy5aqcN2KS9Xc8hAxZB7'], ['USDC', '2gyJ4SZyQtUEXCLRa459nbWaFzuN8uvyoUsVb7xmpkh1'],
  ['MNGO', '4zzgXnhfwdtASw9JugEyrPSKzvaN8i2WSDm1bnGiHFcK'], ['BONK', 'D8yD6us5X7YNeweppFdBR4idGsyPooetuW2fA6Suabqg'],
]);

export const OPTION_MINT_ADDRESS_SEED = 'option-mint';

export const MinContractSize = new Map<string, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.01], ['MNGO', 0.01], ['BONK', 1000],
]);

export const MinOpenBookSize = new Map<string, number>([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.001], ['MNGO', 10], ['BONK', 1000],
]);

export const TickSize = new Map<string, number>([
  ['BTC', 0.1], ['ETH', 0.1], ['SOL', 0.001], ['MNGO', 0.000001], ['BONK', 0.000000001],
]);

export const maxNotional = new Map<string, number>([
  ['BTC', 20000], ['ETH', 10000], ['SOL', 10000], ['MNGO', 2500], ['BONK', 100],
]); // Max hedging $ notional sizes

export const slippageMax = new Map<string, number>([
  ['BTC', 0.0005], ['ETH', 0.0005], ['SOL', 0.0010], ['MNGO', 0.0015], ['BONK', 0.0005],
]); // // Max Allowed xbps above/below FMV on limit orders

// Enter any Staking Options Owned and to be hedged from the treasury
export const treasuryPositions: DIPDeposit[] = [({
  splToken: 'MNGO',
  premiumAsset: 'USDC',
  expirationMs: 1677672000000,
  strike: 0.018,
  type: 'put',
  qty: 6944444,
}),
({
  splToken: 'MNGO',
  premiumAsset: 'USDC',
  expirationMs: 1675252800000,
  strike: 0.020,
  type: 'put',
  qty: 6250000,
}),
({
  splToken: 'BONK',
  premiumAsset: 'USDC',
  expirationMs: 1675166400000,
  strike: 0.0000005,
  type: 'call',
  qty: 10000150,
}), // Actually GSO Position
({
  splToken: 'BONK',
  premiumAsset: 'USDC',
  expirationMs: 1676462400000,
  strike: 0.000003,
  type: 'call',
  qty: 10000000,
}), // Running this until EOM
];

export const rfRate = 0.03; // Risk Free Rate of Return ~ T-Bill Rate
export const twapInterval = 15; // Number of seconds to space spliced delta orders across
export const scalperWindow = 600; // Number of seconds for each gamma scalping window
export const monthAdj = 1; // Adjustment since Date.UTC is zero based
export const percentDrift = 0.05; // Percentage of time to allow drift of the timed actions
export const gammaThreshold = 0.05; // Percentage of gamma to calc delta hedge threshold
export const maxHedges = 4; // Maximum amount of orders to delta hedge across
export const gammaCycles = 10; // Maximum amount of cycles to allow scalps
export const staggerTime = 30; // Seconds to wait between reruns of each product
export const MANGO_DOWNTIME_THRESHOLD = 15; // Time in Minutes to stop routing transactions to Mango
export const fundingThreshold = 0.25; // % Funding to switch to openbook orders
export const maxMktSpread = 0.01; // Max % allowable spread to use midvalue as accurate price
export const gammaCompleteThreshold = 0.90; // Move on to new gamma cycle when 90% filled
export const searchSteps = 5; // Number of times to reduce the jupiter qty to check for routes
export const minExecutionPremium = 0.001; // Min USDC amount to fill MM on
export const JUPITER_LIQUIDITY = 100; // USDC amount to check jupiter mid point price
export const jupiterSlippage = 50; // bps to allow calculating mid price to succeed
export const maxLevels = 100; // max num of levels to search for order book depth
export const maxBackGammaMultiple = 5; // qty to search order book & max multiple of gamma to allow on the back bids
export const PRIORITY_FEE = 1000; // Priority Fee to use for all txs in micro lamports
