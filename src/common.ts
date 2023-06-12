import { Transaction, VersionedTransaction } from '@solana/web3.js';

export type SYMBOL = 'BTC' | 'ETH' | 'SOL' | 'MNGO' | 'BONK' | 'DUAL' | 'USDC' | 'RNDR' | 'UNKNOWN_TOKEN';

export enum CallOrPut {
  Call = 'call',
  Put = 'put'
}

export interface DIPDeposit {
  splTokenName: SYMBOL;
  premiumAssetName: string;
  expirationMs: number;
  strikeUsdcPerToken: number;
  callOrPut: CallOrPut;
  qtyTokens: number;
}

export interface RouteDetails {
  price: number;
  qty: number;
  venue: string;
  swapTransaction: Transaction | VersionedTransaction,
}
