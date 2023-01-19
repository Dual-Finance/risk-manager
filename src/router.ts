/* eslint-disable */
import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import { blackScholes } from 'black-scholes';
import {
  DIPDeposit,
} from './common';
import {
  API_URL,
  cluster,
  DUAL_API,
  usdcMintPk,
  dualMarketProgramID,
  optionVaultPk,
  OPTION_MINT_ADDRESS_SEED,
  PROTCOL_API_KEY,
  BVE_VOL_MAP,
  minExecutionPremium,
  volSpread,
} from './config';
import Poller from './poller';
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getPythPrice,
  parseDipState,
  splMintToToken,
  tokenToSplMint,
} from './utils';
import { getAssociatedTokenAddress } from '@project-serum/associated-token';
import * as apiSecret from '../apiSecret.json';

const crypto = require('crypto');

export class Router {
  mm_callback: (d: DIPDeposit[]) => void;

  risk_manager_callback: (d: DIPDeposit[]) => void;

  dips: { [name: string]: DIPDeposit };

  token: string;

  constructor(
    mm_callback: (d: DIPDeposit[]) => void,
    risk_manager_callback: (d: DIPDeposit[]) => void,
    token: string,
  ) {
    this.mm_callback = mm_callback;
    this.risk_manager_callback = risk_manager_callback;
    this.dips = {};
    this.token = token;
  }

  // Accepts a DIP Deposit and decides whether to send it to the mm_callback
  // or risk_manager_callback
  route(dip_deposit: DIPDeposit): void {
    const date = new Date(dip_deposit.expirationMs);

    // TODO: Update this for other types of assets

    const symbol = `${dip_deposit.splTokenMint},USDC,${date.getUTCFullYear()}-${
      date.getUTCMonth() + 1
    }-${date.getUTCDate()},${dip_deposit.strikeUsdcPerToken * 1_000_000},UPSIDE,E,P`;
    console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log('Routing for', symbol, 'Deposit:', dip_deposit, new Date().toUTCString());

    // This happens after sending tokens to a MM. Exit early.
    if (dip_deposit.qtyTokens == 0) {
      this.dips[
        this.dip_to_string(dip_deposit.expirationMs / 1_000, dip_deposit.strikeUsdcPerToken)
      ] = dip_deposit;
      console.log('DIP Deposit quantity zero. No Rerun');
      return;
    }
    this.fetchMMOrder(symbol).then(async (order) => {
      // Run the risk manager if there is no MM order
      // @ts-ignore
      if (!order || Number(order.remainingQuantity) < dip_deposit.qtyTokens) {
        this.dips[
          this.dip_to_string(
            dip_deposit.expirationMs / 1_000,
            dip_deposit.strikeUsdcPerToken,
          )
        ] = dip_deposit;
        this.run_risk_manager();
        console.log('No available MM bid', order);
        return;
      }

      const currentPrice = await getPythPrice(new PublicKey(tokenToSplMint(dip_deposit.splTokenMint)));
      const fractionOfYear = (dip_deposit.expirationMs - Date.now() ) / (365 * 24 * 60 * 60 * 1_000);
      const vol = BVE_VOL_MAP.get(dip_deposit.splTokenMint) * (1 + volSpread + Math.random() * volSpread);
      const thresholdPrice = blackScholes(currentPrice, dip_deposit.strikeUsdcPerToken, fractionOfYear, vol, 0.01, 'call');
      // @ts-ignore
      const { price } = order;
      console.log('MM price:', price, 'BVE Re-Route price:', thresholdPrice);
      const userPremium = price * dip_deposit.qtyTokens;
      if (userPremium < minExecutionPremium) {
        // If user premium is too small don't bother spamming MM
        console.log('Not routing too small of a trade:', userPremium, minExecutionPremium);
        this.dips[
          this.dip_to_string(
            dip_deposit.expirationMs / 1_000,
            dip_deposit.strikeUsdcPerToken,
          )
        ] = dip_deposit;
        this.run_risk_manager();
        return;
      }

      if (thresholdPrice > price || !(thresholdPrice > 0)) {
        // If the price is worse than the BVE, then do not use the MM, treat it
        // like there is no MM bid.
        console.log('Not routing to MM due to price:', thresholdPrice, price);
        this.dips[
          this.dip_to_string(
            dip_deposit.expirationMs / 1_000,
            dip_deposit.strikeUsdcPerToken,
          )
        ] = dip_deposit;
        this.run_risk_manager();
        return;
      }

      const client_order_id = `clientOrderId${Date.now()}`;
      const side = 'SELL';
      const quantity = dip_deposit.qtyTokens;
      // @ts-ignore
      const secret = apiSecret.default;

      const request = `clientOrderId=${client_order_id}&symbol=${symbol}&price=${price}&quantity=${quantity}&side=${side}`;
      const calculated_hash = crypto
        .createHmac('SHA256', secret)
        .update(Buffer.from(request))
        .digest('hex');

      const data = {
        symbol,
        price,
        quantity,
        side,
        clientOrderId: client_order_id,
        signature: calculated_hash,
      };

      console.log('Creating api order for buy', data);
      const response = await fetch(`${DUAL_API}/orders/createorder`, {
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': PROTCOL_API_KEY,
        },
        body: JSON.stringify(data),
      });
      console.log('API response', await response.json());
    });
  }

  // Todo use this routing logic only once for reruns and new trades
  // Reads all DIP Deposits and decides whether to send it to the mm_callback
  async checkMMPrices(): Promise<void> {
    for (const dip_deposit of Object.values(this.dips)) {
      if (dip_deposit.qtyTokens > 0) {
        const date = new Date(dip_deposit.expirationMs);
        // TODO: Update this for other types of assets
        const symbol = `${dip_deposit.splTokenMint},USDC,${date.getUTCFullYear()}-${
          date.getUTCMonth() + 1
        }-${date.getUTCDate()},${dip_deposit.strikeUsdcPerToken * 1_000_000},UPSIDE,E,P`;
        console.log('######################################################################');
        console.log('Checking MM Quotes vs ', symbol, 'Deposit:', dip_deposit, new Date().toUTCString());

        this.fetchMMOrder(symbol).then(async (order) => {
          // @ts-ignore
          if (!order || Number(order.remainingQuantity) < dip_deposit.qtyTokens) {
            this.dips[
              this.dip_to_string(
                dip_deposit.expirationMs / 1_000,
                dip_deposit.strikeUsdcPerToken,
              )
            ] = dip_deposit;
            console.log('No available MM bid', order);
            return;
          }

          const currentPrice = await getPythPrice(new PublicKey(tokenToSplMint(dip_deposit.splTokenMint)));
          const fractionOfYear = (dip_deposit.expirationMs - Date.now() ) / (365 * 24 * 60 * 60 * 1_000);
          const vol = BVE_VOL_MAP.get(dip_deposit.splTokenMint) * (1 + volSpread + Math.random() * volSpread);
          const thresholdPrice = blackScholes(currentPrice, dip_deposit.strikeUsdcPerToken, fractionOfYear, vol, 0.01, 'call');
          // @ts-ignore
          const { price } = order;
          console.log('MM price:', price, 'BVE price:', thresholdPrice);
          const userPremium = price * dip_deposit.qtyTokens;
          if (userPremium < minExecutionPremium) {
            // If user premium is too small don't bother spamming MM
            console.log('Not routing too small of a trade:', userPremium, minExecutionPremium);
            this.dips[
              this.dip_to_string(
                dip_deposit.expirationMs / 1_000,
                dip_deposit.strikeUsdcPerToken,
              )
            ] = dip_deposit;
            return;
          }

          if (thresholdPrice > price || !(thresholdPrice > 0)) {
            // If the price is worse than the BVE, then do not use the MM, treat it
            // like there is no MM bid.
            console.log('Not routing to MM due to price:', thresholdPrice, price);
            this.dips[
              this.dip_to_string(
                dip_deposit.expirationMs / 1_000,
                dip_deposit.strikeUsdcPerToken,
              )
            ] = dip_deposit;
            return;
          }

          const client_order_id = `clientOrderId${Date.now()}`;
          const side = 'SELL';
          const quantity = dip_deposit.qtyTokens;
          // @ts-ignore
          const secret = apiSecret.default;

          const request = `clientOrderId=${client_order_id}&symbol=${symbol}&price=${price}&quantity=${quantity}&side=${side}`;
          const calculated_hash = crypto
            .createHmac('SHA256', secret)
            .update(Buffer.from(request))
            .digest('hex');

          const data = {
            symbol,
            price,
            quantity,
            side,
            clientOrderId: client_order_id,
            signature: calculated_hash,
          };

          console.log('Creating api order for buy', data);
          const response = await fetch(`${DUAL_API}/orders/createorder`, {
            method: 'post',
            headers: {
              'Content-Type': 'application/json',
              'X-MBX-APIKEY': PROTCOL_API_KEY,
            },
            body: JSON.stringify(data),
          });
          console.log('API response', await response.json());
        });
      }
    }
  }

  run_risk_manager(): void {
    this.risk_manager_callback(Object.values(this.dips));
  }

  async fetchMMOrder(symbol: string): Promise<number> {
    // TODO: Lookup in the pricing object on chain
    try {
      const order = (
        await (
          await fetch(`${DUAL_API}/symbols/getprice?symbol=${symbol}`, {
            method: 'get',
            headers: { 'Content-Type': 'application/json' },
          })
        ).json()
      )[0];
      return order;
    } catch (err) {
      return undefined;
    }
  }

  async add_dip(
    expirationSec: number,
    strike: number,
    splMint: PublicKey,
    connection: Connection,
  ): Promise<void> {
    const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
      OPTION_MINT_ADDRESS_SEED,
      strike * 1_000_000,
      expirationSec,
      splMint,
      usdcMintPk,
      dualMarketProgramID,
    );
    const mmOptionAccount = await getAssociatedTokenAddress(
      optionVaultPk,
      optionMint,
    );
    const balance = await connection.getTokenAccountBalance(mmOptionAccount);

    this.dips[this.dip_to_string(expirationSec, strike)] = {
      splTokenMint: splMintToToken(splMint),
      premiumAssetName: 'USDC',
      expirationMs: expirationSec * 1_000,
      strikeUsdcPerToken: strike,
      callOrPut: 'call',
      qtyTokens: Number(balance.value.uiAmount),
    };
  }

  dip_to_string(expirationSec: number, strike: number): string {
    return `Expiration:${expirationSec}_Strike:${strike}`;
  }

  async refresh_dips() {
    console.log('Refreshing dips', API_URL);
    const connection = new Connection(API_URL, 'processed' as Commitment);
    const programAccountsPromise = connection.getProgramAccounts(dualMarketProgramID);

    await programAccountsPromise.then(async (data) => {
      for (const programAccount of data) {
        if (programAccount.account.data.length !== 260) {
          continue;
        }
        const dipState = parseDipState(programAccount.account.data);

        const strike: number = dipState.strike / 1_000_000;
        const { expiration } = dipState;
        const expirationSec = expiration;
        const { splMint } = dipState;

        const durationMs = expirationSec * 1_000 - Date.now();
        if (durationMs < 0 || durationMs > 1_000 * 60 * 60 * 24 * 30 * 6) {
          continue;
        }

        if (splMintToToken(splMint) == this.token) {
          const alreadyPolled: boolean = this.dip_to_string(expirationSec, strike) in this.dips;

          // Always run add_dip since it refreshes the values if the subscribe
          // fails. Can fail in devnet because some incorrectly defined DIPs.
          try {
            await this.add_dip(expirationSec, strike, splMint, connection);
          } catch (err) {
            console.log('Failed to add dip');
            continue;
          }

          if (alreadyPolled) {
            continue;
          }

          const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
            OPTION_MINT_ADDRESS_SEED,
            strike * 1_000_000,
            expiration,
            splMint,
            usdcMintPk,
            dualMarketProgramID,
          );
          const mmOptionAccount = await getAssociatedTokenAddress(
            optionVaultPk,
            optionMint,
          );

          // Create a poller
          const poller: Poller = new Poller(
            cluster,
            this.token,
            'USD',
            expirationSec,
            strike,
            'call',
            (deposit: DIPDeposit) => {
              this.route(deposit);
            },
          );

          // Start polling for a specific DIP option token account
          await poller.subscribe(mmOptionAccount.toBase58());
        }
      }
    });
  }
}
