import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import { blackScholes } from 'black-scholes';
import { getAssociatedTokenAddress } from '@project-serum/associated-token';
import {
  CallOrPut,
  DIPDeposit,
  SYMBOL,
} from './common';
import {
  API_URL,
  cluster,
  DUAL_API,
  usdcPk,
  BVE_VOL_MAP,
  minExecutionPremium,
  volSpread,
  rfRate,
} from './config';
import Poller from './poller';
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getPythPrice,
  parseDipState,
  splMintToToken,
  tokenToSplMint,
} from './utils';
import * as apiSecret from '../apiSecret.json';
import {
  dualMarketProgramID, MS_PER_YEAR, NUM_DIP_ATOMS_PER_TOKEN, optionVaultPk,
  OPTION_MINT_ADDRESS_SEED, PROTCOL_API_KEY,
} from './constants';
import { dipToString, fetchMMOrder } from './router_utils';

const crypto = require('crypto');

class Router {
  mmCallback: (d: DIPDeposit[]) => void;
  riskManagerCallback: (d: DIPDeposit[]) => void;
  dips: { [name: string]: DIPDeposit };
  token: SYMBOL;

  constructor(
    mmCallback: (d: DIPDeposit[]) => void,
    riskManagerCallback: (d: DIPDeposit[]) => void,
    token: SYMBOL,
  ) {
    this.mmCallback = mmCallback;
    this.riskManagerCallback = riskManagerCallback;
    this.dips = {};
    this.token = token;
  }

  // Accepts a DIP Deposit and decides whether to send it to the mm_callback
  // or risk_manager_callback
  async route(dipDeposit: DIPDeposit): Promise<void> {
    const date = new Date(dipDeposit.expirationMs);

    // TODO: Update this for other types of assets

    const symbol = `${dipDeposit.splTokenName},USDC,${date.getUTCFullYear()}-${
      date.getUTCMonth() + 1
    }-${date.getUTCDate()},${dipDeposit.strikeUsdcPerToken * 1_000_000},UPSIDE,E,P`;
    console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log('Routing', dipDeposit.qtyTokens, symbol, new Date().toUTCString());

    // This happens after sending tokens to a MM. Exit early.
    if (dipDeposit.qtyTokens === 0) {
      this.dips[
        dipToString(dipDeposit.expirationMs / 1_000, dipDeposit.strikeUsdcPerToken)
      ] = dipDeposit;
      console.log('DIP Deposit quantity zero. Rerun');
      this.run_risk_manager();
      return;
    }

    await fetchMMOrder(symbol).then(async (order) => {
      // Run the risk manager if there is no MM order
      // @ts-ignore
      if (!order || Number(order.remainingQuantity) < dipDeposit.qtyTokens) {
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
          )
        ] = dipDeposit;
        console.log('No available MM bid', order);
        this.run_risk_manager();
        return;
      }

      const currentPrice = await getPythPrice(
        new PublicKey(tokenToSplMint(dipDeposit.splTokenName)),
      );
      const fractionOfYear = (dipDeposit.expirationMs - Date.now()) / MS_PER_YEAR;
      const vol = BVE_VOL_MAP.get(
        dipDeposit.splTokenName,
      ) * (1 + volSpread + Math.random() * volSpread);
      const thresholdPrice = blackScholes(currentPrice, dipDeposit.strikeUsdcPerToken, fractionOfYear, vol, rfRate, 'call');
      // @ts-ignore
      const { price } = order;
      console.log('MM price:', price, 'BVE Re-Route price:', thresholdPrice);
      const userPremium = price * dipDeposit.qtyTokens;
      if (userPremium < minExecutionPremium) {
        // If user premium is too small don't bother spamming MM
        console.log('Not routing too small of a trade:', userPremium, minExecutionPremium);
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
          )
        ] = dipDeposit;
        this.run_risk_manager();
        return;
      }

      if (thresholdPrice > price || !(thresholdPrice > 0)) {
        // If the price is worse than the BVE, then do not use the MM, treat it
        // like there is no MM bid.
        console.log('Not routing to MM due to price:', thresholdPrice, price);
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
          )
        ] = dipDeposit;
        this.run_risk_manager();
        return;
      }

      const clientOrderId = `clientOrderId${Date.now()}`;
      const side = 'SELL';
      const quantity = dipDeposit.qtyTokens;
      // @ts-ignore
      const secret = apiSecret.default;

      const request = `clientOrderId=${clientOrderId}&symbol=${symbol}&price=${price}&quantity=${quantity}&side=${side}`;
      const calculatedHash = crypto
        .createHmac('SHA256', secret)
        .update(Buffer.from(request))
        .digest('hex');

      const data = {
        symbol,
        price,
        quantity,
        side,
        clientOrderId,
        signature: calculatedHash,
      };

      console.log('Creating api order to sell', data);
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

  // Reads all DIP Deposits and decides whether to send it to the mm_callback
  async checkMMPrices(): Promise<void> {
    let openPositionCount = 0;
    for (const dipDeposit of Object.values(this.dips)) {
      if (dipDeposit.qtyTokens > 0) {
        openPositionCount++;
        await this.route(dipDeposit);
      }
    }
    // On startup run risk manager when there is no position
    if (openPositionCount === 0) {
      console.log('No Positions. Run Risk Manager', new Date().toUTCString());
      this.run_risk_manager();
    } else {
      console.log('Open DIP Positions', openPositionCount);
    }
  }

  run_risk_manager(): void {
    this.riskManagerCallback(Object.values(this.dips));
  }

  async add_dip(
    expirationSec: number,
    strike: number,
    splMint: PublicKey,
    connection: Connection,
  ): Promise<void> {
    const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
      OPTION_MINT_ADDRESS_SEED,
      strike * NUM_DIP_ATOMS_PER_TOKEN,
      expirationSec,
      splMint,
      usdcPk,
      dualMarketProgramID,
    );
    const mmOptionAccount = await getAssociatedTokenAddress(
      optionVaultPk,
      optionMint,
    );
    const balance = await connection.getTokenAccountBalance(mmOptionAccount);

    this.dips[dipToString(expirationSec, strike)] = {
      splTokenName: splMintToToken(splMint),
      premiumAssetName: 'USDC',
      expirationMs: expirationSec * 1_000,
      strikeUsdcPerToken: strike,
      callOrPut: CallOrPut.Call,
      qtyTokens: Number(balance.value.uiAmount),
    };
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

        if (splMintToToken(splMint) === this.token) {
          const alreadyPolled: boolean = dipToString(expirationSec, strike) in this.dips;

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
            usdcPk,
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
            'USDC',
            expirationSec,
            strike,
            CallOrPut.Call,
            (deposit: DIPDeposit) => {
              this.route(deposit);
            },
          );

          // Start polling for a specific DIP option token account
          poller.subscribe(mmOptionAccount.toBase58());
        }
      }
    });
  }
}

export default Router;
