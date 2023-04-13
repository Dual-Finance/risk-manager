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
  CLUSTER,
  DUAL_API,
  usdcPk,
  BVE_VOL_MAP,
  MIN_EXECUTION_PREMIUM,
  VOL_SPREAD,
  RF_RATE,
  MAX_ROUTE_ATTEMPTS,
  MM_REFRESH_TIME,
  NO_ROUTED_SIZE,
} from './config';
import Poller from './poller';
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getPythPrice,
  parseDipState,
  sleepExact,
  splMintToToken,
  tokenToSplMint,
} from './utils';
import * as apiSecret from '../apiSecret.json';
import {
  DIP_STATE_LENGTH,
  DIP_PROGRAM_ID, MS_PER_YEAR, NUM_DIP_ATOMS_PER_TOKEN, OPTION_VAULT_PK,
  OPTION_MINT_ADDRESS_SEED, PROTCOL_API_KEY, SIX_MONTHS_IN_MS,
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
  async route(dipDeposit: DIPDeposit, routerID: number): Promise<number> {
    let routedSize = 0;
    const date = new Date(dipDeposit.expirationMs);

    // TODO: Update this for other types of assets

    const symbol = `${dipDeposit.splTokenName},USDC,${date.getUTCFullYear()}-${
      date.getUTCMonth() + 1
    }-${date.getUTCDate()},${dipDeposit.strikeUsdcPerToken * 1_000_000},UPSIDE,E,P`;
    console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log('ROUTER:', routerID, 'Routing', dipDeposit.qtyTokens, symbol, new Date().toUTCString());

    // This happens after sending tokens to a MM. Exit early.
    if (dipDeposit.qtyTokens === 0) {
      this.dips[
        dipToString(dipDeposit.expirationMs / 1_000, dipDeposit.strikeUsdcPerToken)
      ] = dipDeposit;
      console.log('ROUTER:', routerID, 'DIP Deposit quantity zero. Rerun');
      return NO_ROUTED_SIZE;
    }

    await fetchMMOrder(symbol).then(async (order) => {
      // Run the risk manager if there is no MM order
      if (!order || order.price === undefined || Number(order.remainingQuantity) === 0) {
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
          )
        ] = dipDeposit;
        console.log('ROUTER:', routerID, 'No available MM bid', order);
        return NO_ROUTED_SIZE;
      }

      const currentPrice = await getPythPrice(
        new PublicKey(tokenToSplMint(dipDeposit.splTokenName)),
      );
      const fractionOfYear = (dipDeposit.expirationMs - Date.now()) / MS_PER_YEAR;
      const vol = BVE_VOL_MAP.get(
        dipDeposit.splTokenName,
      ) * (1 + VOL_SPREAD + Math.random() * VOL_SPREAD);
      const thresholdPrice = blackScholes(currentPrice, dipDeposit.strikeUsdcPerToken, fractionOfYear, vol, RF_RATE, 'call');
      const { price, remainingQuantity } = order;
      console.log('ROUTER:', routerID, 'MM price:', price, 'BVE Re-Route price:', thresholdPrice);
      const userPremium = price * dipDeposit.qtyTokens;
      if (userPremium < MIN_EXECUTION_PREMIUM) {
        // If user premium is too small don't bother spamming MM
        console.log('ROUTER:', routerID, 'Not routing too small of a trade:', userPremium, MIN_EXECUTION_PREMIUM);
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
          )
        ] = dipDeposit;
        return NO_ROUTED_SIZE;
      }

      if (thresholdPrice > price || !(thresholdPrice > 0)) {
        // If the price is worse than the BVE, then do not use the MM, treat it
        // like there is no MM bid.
        console.log('ROUTER:', routerID, 'Not routing to MM due to price:', thresholdPrice, price);
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
          )
        ] = dipDeposit;
        return NO_ROUTED_SIZE;
      }

      const clientOrderId = `clientOrderId${Date.now()}`;
      const side = 'SELL';
      const quantityDIP = dipDeposit.qtyTokens;
      const quantityTrade = Math.min(quantityDIP, remainingQuantity);
      // @ts-ignore
      const secret = apiSecret.default;

      const request = `clientOrderId=${clientOrderId}&symbol=${symbol}&price=${price}&quantity=${quantityTrade}&side=${side}`;
      const calculatedHash = crypto
        .createHmac('SHA256', secret)
        .update(Buffer.from(request))
        .digest('hex');

      const data = {
        symbol,
        price,
        quantity: quantityTrade,
        side,
        clientOrderId,
        signature: calculatedHash,
      };

      console.log('ROUTER:', routerID, 'Creating api order to sell', data);
      const response = await fetch(`${DUAL_API}/orders/createorder`, {
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': PROTCOL_API_KEY,
        },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        throw new Error('Failed to sell to API');
      }
      console.log('ROUTER:', routerID, 'API response', await response.json());
      routedSize = quantityTrade;
      return quantityTrade;
    });
    return routedSize;
  }

  // Reads existing DIP Deposits & new deposit and decides whether to send it to the mm_callback
  async checkMMPrices(dipDeposit?: DIPDeposit): Promise<void> {
    const routerID = new Date().getTime();
    let openPositionCount = 0;
    let routedQty = 0;
    let totalRoutedQty = 0;
    try {
      if (dipDeposit !== undefined) {
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
          )
        ] = dipDeposit;
        console.log('ROUTER:', routerID, 'DIP Position Change', dipDeposit);
      }
      for (let i = 0; i < MAX_ROUTE_ATTEMPTS; i++) {
        routedQty = 0;
        for (const dip of Object.values(this.dips)) {
          if (dip.qtyTokens > 0) {
            openPositionCount++;
            // TODO: SOs probably don't need to check MM prices yet
            routedQty = await this.route(dip, routerID);
            totalRoutedQty += routedQty;
          }
        }
        if (routedQty === 0) {
          console.log('ROUTER:', routerID, 'Checked', openPositionCount, 'Open DIP Positions.', totalRoutedQty, 'Total Routed');
          break;
        }
        if (dipDeposit !== undefined) {
          if (totalRoutedQty === dipDeposit.qtyTokens) {
            console.log('ROUTER:', routerID, 'Routed All.', totalRoutedQty, 'Routed vs.', dipDeposit.qtyTokens, 'DIPs', i);
            break;
          }
        }
        console.log('ROUTER:', routerID, 'Routed', routedQty, 'DIPs. Wait', MM_REFRESH_TIME, 'seconds to check refreshed MM Orders', i);
        await sleepExact(MM_REFRESH_TIME);
        await this.refresh_dips_poller_accounts();
      }
      // Poller will immediately fire after position changes so no need to run risk manager
      if (totalRoutedQty > 0) {
        console.log('ROUTER:', routerID, 'Sucessfully routed to MM. Use Position Change or Rerun to run Risk Manager');
        return;
      }
    } catch (err) {
      console.log('ROUTER:', routerID, 'Failed to route with error: ', err, 'proceeding to Run Risk Manager.');
    }
    await this.refresh_dips_poller_accounts();
    if (dipDeposit !== undefined) {
      // TODO: Only run RM here if position changed from prior run
      console.log('ROUTER:', routerID, 'No Routing to MM. Run Risk Manager');
      this.run_risk_manager();
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
      DIP_PROGRAM_ID,
    );
    const mmOptionAccount = await getAssociatedTokenAddress(
      OPTION_VAULT_PK,
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

  async refresh_dips_poller_accounts() : Promise<[Poller[], string[]]> {
    console.log('Refreshing dips', API_URL);
    const pollers: Poller[] = [];
    const mmAccounts: string[] = [];
    const connection = new Connection(API_URL, 'processed' as Commitment);
    const programAccountsPromise = connection.getProgramAccounts(DIP_PROGRAM_ID);

    await programAccountsPromise.then(async (data) => {
      for (const programAccount of data) {
        if (programAccount.account.data.length !== DIP_STATE_LENGTH) {
          continue;
        }
        const dipState = parseDipState(programAccount.account.data);

        const strikeTokensPerToken: number = dipState.strikeAtomsPerToken / NUM_DIP_ATOMS_PER_TOKEN;
        const { expiration } = dipState;
        const expirationSec = expiration;
        const { splMint } = dipState;

        const durationMs = expirationSec * 1_000 - Date.now();
        if (durationMs < 0 || durationMs > SIX_MONTHS_IN_MS) {
          continue;
        }

        if (splMintToToken(splMint) === this.token) {
          const alreadyPolled = dipToString(expirationSec, strikeTokensPerToken) in this.dips;

          // Always run add_dip since it refreshes the values if the subscribe
          // fails. Can fail in devnet because some incorrectly defined DIPs.
          try {
            await this.add_dip(expirationSec, strikeTokensPerToken, splMint, connection);
          } catch (err) {
            console.log('Failed to add dip');
            continue;
          }

          if (alreadyPolled) {
            continue;
          }

          const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
            OPTION_MINT_ADDRESS_SEED,
            strikeTokensPerToken * NUM_DIP_ATOMS_PER_TOKEN,
            expiration,
            splMint,
            usdcPk,
            DIP_PROGRAM_ID,
          );
          const mmOptionAccount = await getAssociatedTokenAddress(
            OPTION_VAULT_PK,
            optionMint,
          );

          // Create a poller
          const poller: Poller = new Poller(
            CLUSTER,
            this.token,
            'USDC',
            expirationSec,
            strikeTokensPerToken,
            CallOrPut.Call,
            // TODO: Need to add a delay to Poller or check on a timer
            (deposit: DIPDeposit) => {
              this.checkMMPrices(deposit);
            },
          );

          mmAccounts.push(mmOptionAccount.toBase58());
          pollers.push(poller);
        }
      }
    });
    return [pollers, mmAccounts];
  }

  async refresh_so_poller_accounts() : Promise<Poller> {
    console.log('Refreshing Staking Options', API_URL);

    // TODO: Parse SO State for expiration & strike
    const poller: Poller = new Poller(
      CLUSTER,
      this.token,
      'USDC',
      1682683200000,
      0.0000006,
      CallOrPut.Call,
      // TODO: Consider renaming OptionDeposit since usable DIPs & SO
      (deposit: DIPDeposit) => {
        // TOOD: Directly route to RM?
        this.checkMMPrices(deposit);
      },
    );
    return poller;
  }
}

export default Router;
