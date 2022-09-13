import { DIPDeposit } from "./common";
import {
  Connection,
  AccountChangeCallback,
  PublicKey,
  AccountInfo as solanaAccountInfo,
  Context,
} from "@solana/web3.js";
import { AccountInfo, AccountLayout, u64 } from "@solana/spl-token";
import { WEBSOCKET_URL } from "./config";

export class Poller {
  cluster: string;
  callback: (deposit: DIPDeposit) => void;
  splToken: string;
  premiumAsset: string;
  expirationSec: number;
  strike: number;
  type: string;

  constructor(
    cluster: string,
    splToken: string,
    premiumAsset: string,
    expirationSec: number,
    strike: number,
    type: string,
    callback: (deposit: DIPDeposit) => void
  ) {
    this.cluster = cluster;
    this.callback = callback;
    this.splToken = splToken;
    this.premiumAsset = premiumAsset;
    this.expirationSec = expirationSec;
    this.strike = strike;
    this.type = type;
  }

  subscribe(address: string): void {
    console.log("Listening at:", address);
    // @ts-ignore
    const connection: Connection = new Connection(WEBSOCKET_URL);
    const callback: AccountChangeCallback = (
      accountInfo: solanaAccountInfo<Buffer>,
      _context: Context
    ) => {
      // @ts-ignore
      const new_amount = parseTokenAccount(accountInfo.data).amount.toNumber();
      let decimals = 6;
      switch(this.splToken) {
        // BTC
        case 'JDXktC6gbDXq4zuW3BT6ToSE7timShHQBL449ULDdoMv':
        case '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E':
          decimals = 6;
          break;
        // ETH
        case 'Hccuen6RkUgEvyL9oSXW8ai9QiQaAiL8ESaqjp9oymBf':
        case '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs':
          decimals = 7;
          break;
        // SOL
        case 'So11111111111111111111111111111111111111112':
          decimals = 8;
          break;
        default:
          break;
      }

      const dip_deposit = {
        splToken: this.splToken,
        premiumAsset: this.premiumAsset,
        expirationMs: this.expirationSec * 1_000,
        strike: this.strike,
        type: this.type,
        qty: new_amount / Math.pow(10, decimals),
      };
      this.callback(dip_deposit);
    };

    // Watch the vault spl token account
    try{
      connection.onAccountChange(new PublicKey(address), callback);
    } catch (err){
      console.log(err);
    }
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
