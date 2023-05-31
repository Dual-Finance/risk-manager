import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import { blackScholes } from 'black-scholes';
import { getAssociatedTokenAddress } from '@project-serum/associated-token';
import {
  CallOrPut, DIPDeposit, SYMBOL,
} from './common';
import {
  API_URL, CLUSTER, DUAL_API, BVE_VOL_MAP, MIN_EXECUTION_PREMIUM,
  VOL_SPREAD, RF_RATE, MAX_ROUTE_ATTEMPTS, MM_REFRESH_TIME, NO_ROUTED_SIZE,
} from './config';
import Poller from './poller';
import {
  findProgramAddressWithMintAndStrikeAndExpiration, getPythPrice, parseDipState,
  sleepExact, splMintToToken, tokenToSplMint, decimalsBaseSPL,
} from './utils';
import * as apiSecret from '../apiSecret.json';
import {
  DIP_STATE_LENGTH, DIP_PROGRAM_ID, MS_PER_YEAR, NUM_DIP_ATOMS_PER_TOKEN,
  OPTION_VAULT_PK, OPTION_MINT_ADDRESS_SEED, PROTCOL_API_KEY, SIX_MONTHS_IN_MS,
} from './constants';
import { dipToString, fetchMMOrder } from './router_utils';
import { calcForwardPrice } from './scalper_utils';

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

    const upOrDown = dipDeposit.callOrPut === CallOrPut.Call ? 'UPSIDE' : 'DOWNSIDE';
    const symbol = `${dipDeposit.splTokenName},USDC,${date.getUTCFullYear()}-${
      date.getUTCMonth() + 1
    }-${date.getUTCDate()},${Number((dipDeposit.strikeUsdcPerToken * 1000000).toPrecision(6))},${upOrDown},E,P`;
    console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log('Router ID:', routerID, 'Routing', dipDeposit.qtyTokens, symbol, new Date().toUTCString());

    // This happens after sending tokens to a MM. Exit early.
    if (dipDeposit.qtyTokens === 0) {
      this.dips[
        dipToString(
          dipDeposit.expirationMs / 1_000,
          dipDeposit.strikeUsdcPerToken,
          dipDeposit.callOrPut,
        )
      ] = dipDeposit;
      console.log('Router ID:', routerID, 'DIP Deposit quantity zero. Rerun');
      return NO_ROUTED_SIZE;
    }

    await fetchMMOrder(symbol).then(async (order) => {
      // Run the risk manager if there is no MM order
      if (!order || order.price === undefined || Number(order.remainingQuantity) === 0) {
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
            dipDeposit.callOrPut,
          )
        ] = dipDeposit;
        console.log('Router ID:', routerID, 'No available MM bid', order);
        return NO_ROUTED_SIZE;
      }

      const currentPrice = await getPythPrice(
        new PublicKey(tokenToSplMint(dipDeposit.splTokenName)),
      );
      const fractionOfYear = (dipDeposit.expirationMs - Date.now()) / MS_PER_YEAR;
      const vol = BVE_VOL_MAP.get(
        dipDeposit.splTokenName,
      ) * (1 + VOL_SPREAD + Math.random() * VOL_SPREAD);
      const fwdPrice = calcForwardPrice(dipDeposit.splTokenName, currentPrice, fractionOfYear);
      const thresholdPrice = blackScholes(
        fwdPrice,
        dipDeposit.strikeUsdcPerToken,
        fractionOfYear,
        vol,
        RF_RATE,
        dipDeposit.callOrPut,
      );
      const { price, remainingQuantity } = order;
      console.log('Router ID:', routerID, 'MM price:', price, 'BVE Re-Route price:', thresholdPrice);
      const userPremium = price * dipDeposit.qtyTokens;
      if (userPremium < MIN_EXECUTION_PREMIUM) {
        // If user premium is too small don't bother spamming MM
        console.log('Router ID:', routerID, 'Not routing too small of a trade:', userPremium, MIN_EXECUTION_PREMIUM);
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
            dipDeposit.callOrPut,
          )
        ] = dipDeposit;
        return NO_ROUTED_SIZE;
      }

      if (thresholdPrice > price || !(thresholdPrice > 0)) {
        // If the price is worse than the BVE, then do not use the MM, treat it
        // like there is no MM bid.
        console.log('Router ID:', routerID, 'Not routing to MM due to price:', thresholdPrice, price);
        this.dips[
          dipToString(
            dipDeposit.expirationMs / 1_000,
            dipDeposit.strikeUsdcPerToken,
            dipDeposit.callOrPut,
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

      console.log('Router ID:', routerID, 'Creating api order to sell', data);
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
      console.log('Router ID:', routerID, 'API response', await response.json());
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
            dipDeposit.callOrPut,
          )
        ] = dipDeposit;
        console.log('Router ID:', routerID, 'DIP Position Change', dipDeposit);
      }
      for (let i = 0; i < MAX_ROUTE_ATTEMPTS; i++) {
        routedQty = 0;
        for (const dip of Object.values(this.dips)) {
          if (dip.qtyTokens > 0) {
            openPositionCount++;
            routedQty = await this.route(dip, routerID);
            totalRoutedQty += routedQty;
          }
        }
        if (routedQty === 0) {
          console.log('Router ID:', routerID, 'Checked', openPositionCount, 'Open DIP Positions.', totalRoutedQty, 'Total Routed');
          break;
        }
        if (dipDeposit !== undefined) {
          if (totalRoutedQty === dipDeposit.qtyTokens) {
            console.log('Router ID:', routerID, 'Routed All.', totalRoutedQty, 'Routed vs.', dipDeposit.qtyTokens, 'DIPs', i);
            break;
          }
        }
        console.log('Router ID:', routerID, 'Routed', routedQty, 'DIPs. Wait', MM_REFRESH_TIME, 'seconds to check refreshed MM Orders', i);
        await sleepExact(MM_REFRESH_TIME);
        await this.refresh_dips_poller_accounts();
      }
      // Poller will immediately fire after position changes so no need to run risk manager
      if (totalRoutedQty > 0) {
        console.log('Router ID:', routerID, 'Sucessfully routed to MM. Use Position Change or Rerun to run Risk Manager');
        return;
      }
    } catch (err) {
      console.log('Router ID:', routerID, 'Failed to route with error: ', err, 'proceeding to Run Risk Manager.');
    }
    await this.refresh_dips_poller_accounts();
    if (dipDeposit !== undefined) {
      // TODO: Only run RM here if position changed from prior run
      console.log('Router ID:', routerID, 'No Routing to MM. Run Risk Manager');
      this.run_risk_manager();
    }
  }

  run_risk_manager(): void {
    this.riskManagerCallback(Object.values(this.dips));
  }

  async add_dip(
    expirationSec: number,
    strikeAtoms: number,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    callOrPut: CallOrPut,
    connection: Connection,
  ): Promise<void> {
    const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
      OPTION_MINT_ADDRESS_SEED,
      strikeAtoms,
      expirationSec,
      baseMint,
      quoteMint,
      DIP_PROGRAM_ID,
    );
    const mmOptionAccount = await getAssociatedTokenAddress(
      OPTION_VAULT_PK,
      optionMint,
    );
    const quoteAtoms = 10 ** decimalsBaseSPL(splMintToToken(quoteMint));
    const strikeUsdcPerToken = callOrPut === CallOrPut.Call
      ? strikeAtoms / quoteAtoms
      : Number(((1 / strikeAtoms) * quoteAtoms).toPrecision(6));
    const balance = await connection.getTokenAccountBalance(mmOptionAccount);
    const splTokenName = callOrPut === CallOrPut.Call
      ? splMintToToken(baseMint)
      : splMintToToken(quoteMint);
    const premiumAssetName = callOrPut === CallOrPut.Call
      ? splMintToToken(quoteMint)
      : splMintToToken(baseMint);
    const tokenQty = callOrPut === CallOrPut.Call
      ? Number(balance.value.uiAmount)
      : Math.floor((Number(balance.value.uiAmount) / strikeUsdcPerToken)
        * NUM_DIP_ATOMS_PER_TOKEN) / NUM_DIP_ATOMS_PER_TOKEN;
    this.dips[dipToString(expirationSec, strikeUsdcPerToken, callOrPut)] = {
      splTokenName,
      premiumAssetName,
      expirationMs: expirationSec * 1_000,
      strikeUsdcPerToken,
      callOrPut,
      qtyTokens: tokenQty,
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

        const expirationSec = dipState.expiration;

        const durationMs = expirationSec * 1_000 - Date.now();
        if (durationMs < 0 || durationMs > SIX_MONTHS_IN_MS) {
          continue;
        }
        const {
          baseMint, quoteMint, expiration, strikeAtomsPerToken,
        } = dipState;
        if (splMintToToken(baseMint) === this.token || splMintToToken(quoteMint) === this.token) {
          const quoteAtoms = 10 ** decimalsBaseSPL(splMintToToken(quoteMint));
          let optionType = CallOrPut.Call;
          let strikeTokensPerToken: number = strikeAtomsPerToken / quoteAtoms;
          if (splMintToToken(quoteMint) === this.token) {
            optionType = CallOrPut.Put;
            strikeTokensPerToken = Number(((1 / strikeAtomsPerToken) * quoteAtoms).toPrecision(6));
          }
          const alreadyPolled = dipToString(
            expirationSec,
            strikeTokensPerToken,
            optionType,
          ) in this.dips;

          // Always run add_dip since it refreshes the values if the subscribe
          // fails. Can fail in devnet because some incorrectly defined DIPs.
          try {
            await this.add_dip(
              expirationSec,
              strikeAtomsPerToken,
              baseMint,
              quoteMint,
              optionType,
              connection,
            );
          } catch (err) {
            console.log('Failed to add dip');
            continue;
          }

          if (alreadyPolled) {
            continue;
          }

          const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
            OPTION_MINT_ADDRESS_SEED,
            strikeAtomsPerToken,
            expiration,
            baseMint,
            quoteMint,
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
            optionType,
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
}

export default Router;
