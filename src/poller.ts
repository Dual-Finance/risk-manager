import {
  Connection,
  AccountChangeCallback,
  PublicKey,
  AccountInfo as solanaAccountInfo,
  Context,
  Commitment,
} from '@solana/web3.js';
import { AccountLayout, u64 } from '@solana/spl-token';
import { DIPDeposit } from './common';
import { API_URL, NUM_DIP_ATOMS_PER_TOKEN } from './config';

class Poller {
  cluster: string;

  callback: (deposit: DIPDeposit) => void;

  splTokenName: string;

  premiumAsset: string;

  expirationSec: number;

  strikeTokens: number;

  callOrPut: string;

  constructor(
    cluster: string,
    splTokenName: string,
    premiumAsset: string,
    expirationSec: number,
    strikeTokens: number,
    callOrPut: string,
    callback: (deposit: DIPDeposit) => void,
  ) {
    this.cluster = cluster;
    this.callback = callback;
    this.splTokenName = splTokenName;
    this.premiumAsset = premiumAsset;
    this.expirationSec = expirationSec;
    this.strikeTokens = strikeTokens;
    this.callOrPut = callOrPut;
  }

  subscribe(address: string): void {
    console.log('Listening at:', address);
    console.log(this.splTokenName);
    const connection = new Connection(API_URL, 'processed' as Commitment);

    const callback: AccountChangeCallback = (
      accountInfo: solanaAccountInfo<Buffer>,
      _context: Context,
    ) => {
      const newAmount: number = u64.fromBuffer(
        AccountLayout.decode(accountInfo.data).amount,
      ).toNumber();

      const dipDeposit: DIPDeposit = {
        splTokenName: this.splTokenName,
        premiumAssetName: this.premiumAsset,
        expirationMs: this.expirationSec * 1_000,
        strikeUsdcPerToken: this.strikeTokens,
        callOrPut: this.callOrPut,
        qtyTokens: newAmount / 10 ** NUM_DIP_ATOMS_PER_TOKEN,
      };
      this.callback(dipDeposit);
    };

    // Watch the vault spl token account
    try {
      connection.onAccountChange(new PublicKey(address), callback);
    } catch (err) {
      console.log(err);
      console.log(err.stack);
    }
  }
}

export default Poller;
