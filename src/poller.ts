import { DIPDeposit } from "./common";
import {
  Connection,
  AccountChangeCallback,
  PublicKey,
  AccountInfo as solanaAccountInfo,
  Context,
  clusterApiUrl,
} from "@solana/web3.js";
import { AccountInfo, AccountLayout, u64 } from "@solana/spl-token";

export class Poller {
  cluster: string;
  callback: (deposit: DIPDeposit) => void;
  splToken: string;
  premiumAsset: string;
  expiration: number;
  strike: number;
  type: string;

  constructor(
    cluster: string,
    splToken: string,
    premiumAsset: string,
    expiration: number,
    strike: number,
    type: string,
    callback: (deposit: DIPDeposit) => void
  ) {
    this.cluster = cluster;
    this.callback = callback;
    this.splToken = splToken;
    this.premiumAsset = premiumAsset;
    this.expiration = expiration;
    this.strike = strike;
    this.type = type;
  }

  subscribe(address: string): void {
    console.log("Listening at:", address);
    const connection: Connection = new Connection(clusterApiUrl(this.cluster));
    const callback: AccountChangeCallback = (
      accountInfo: solanaAccountInfo<Buffer>,
      _context: Context
    ) => {
      // @ts-ignore
      let new_amount = parseTokenAccount(accountInfo.data).amount.toNumber();
      const dip_deposit = {
        splToken: this.splToken,
        premiumAsset: this.premiumAsset,
        expiration: this.expiration * 1_000,
        strike: this.strike,
        type: this.type,
        // TODO: Make this work for different number of decimals
        qty: new_amount / 1_000_000,
      };
      this.callback(dip_deposit);
    };

    // Watch the vault spl token account
    connection.onAccountChange(new PublicKey(address), callback);
  }
}

function parseTokenAccount(data: Buffer): AccountInfo {
  const accountInfo: any = AccountLayout.decode(data);
  accountInfo.mint = new PublicKey(accountInfo.mint);
  accountInfo.owner = new PublicKey(accountInfo.owner);
  accountInfo.amount = u64.fromBuffer(accountInfo.amount);

  if (accountInfo.delegateOption === 0) {
    accountInfo.delegate = null;
    accountInfo.delegatedAmount = new u64();
  } else {
    accountInfo.delegate = new PublicKey(accountInfo.delegate);
    accountInfo.delegatedAmount = u64.fromBuffer(accountInfo.delegatedAmount);
  }

  accountInfo.isInitialized = accountInfo.state !== 0;
  accountInfo.isFrozen = accountInfo.state === 2;

  if (accountInfo.isNativeOption === 1) {
    accountInfo.rentExemptReserve = u64.fromBuffer(accountInfo.isNative);
    accountInfo.isNative = true;
  } else {
    accountInfo.rentExemptReserve = null;
    accountInfo.isNative = false;
  }

  if (accountInfo.closeAuthorityOption === 0) {
    accountInfo.closeAuthority = null;
  } else {
    accountInfo.closeAuthority = new PublicKey(accountInfo.closeAuthority);
  }

  return accountInfo;
}
