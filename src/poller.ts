import {
  Connection,
  AccountChangeCallback,
  PublicKey,
  AccountInfo as solanaAccountInfo,
  Context,
  Commitment,
  Cluster,
} from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import { CallOrPut, DIPDeposit, SYMBOL } from './common';
import { API_URL } from './config';
import { NUM_DIP_ATOMS_PER_TOKEN } from './constants';

class Poller {
  cluster: Cluster;
  callback: (deposit: DIPDeposit) => void;
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
    callback: (deposit: DIPDeposit) => void,
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
      accountInfo: solanaAccountInfo<Buffer>,
      _context: Context,
    ) => {
      const newAmountAtoms: number = Number(
        AccountLayout.decode(accountInfo.data).amount,
      );

      const dipDeposit: DIPDeposit = {
        splTokenName: this.splTokenName,
        premiumAssetName: this.premiumAssetName,
        expirationMs: this.expirationSec * 1_000,
        strikeUsdcPerToken: this.strikeTokens,
        callOrPut: this.callOrPut,
        qtyTokens: newAmountAtoms / NUM_DIP_ATOMS_PER_TOKEN,
      };
      this.callback(dipDeposit);
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
