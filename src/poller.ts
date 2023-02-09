import {
  Connection,
  AccountChangeCallback,
  PublicKey,
  AccountInfo as solanaAccountInfo,
  Context,
  Commitment,
  Cluster,
} from '@solana/web3.js';
import { CallOrPut, SYMBOL } from './common';
import { API_URL } from './config';

class Poller {
  cluster: Cluster;
  callback: () => void;
  splTokenName: SYMBOL;
  premiumAssetName: SYMBOL;
  expirationSec: number;
  strikeTokens: number;
  callOrPut: CallOrPut;

  constructor(
    cluster: Cluster,
    splTokenName: SYMBOL,
    premiumAssetName: SYMBOL,
    expirationSec: number,
    strikeTokens: number,
    callOrPut: CallOrPut,
    callback: () => void,
  ) {
    this.cluster = cluster;
    this.callback = callback;
    this.splTokenName = splTokenName;
    this.premiumAssetName = premiumAssetName;
    this.expirationSec = expirationSec;
    this.strikeTokens = strikeTokens;
    this.callOrPut = callOrPut;
  }

  subscribe(address: string): void {
    console.log('Listening at:', address);
    const connection = new Connection(API_URL, 'processed' as Commitment);

    const callback: AccountChangeCallback = (
      _accountInfo: solanaAccountInfo<Buffer>,
      _context: Context,
    ) => {
      this.callback();
    };

    try {
      connection.onAccountChange(new PublicKey(address), callback);
    } catch (err) {
      console.log(err);
      console.log(err.stack);
    }
  }
}

export default Poller;
