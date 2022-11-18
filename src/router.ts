import { Connection, PublicKey } from "@solana/web3.js";
import {
  DIPDeposit,
} from "./common";
import {
  API_URL,
  cluster,
  DUAL_API,
  usdcMintPk,
  dualMarketProgramID,
  optionVaultPk,
  OPTION_MINT_ADDRESS_SEED,
  PROTCOL_API_KEY,
  THEO_VOL_MAP,
} from "./config";
import { Poller } from "./poller";
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getAssociatedTokenAddress,
  getPythPrice,
  parseDipState,
  splMintToToken,
  tokenToSplMint,
} from "./utils";
import fetch from "cross-fetch";
import * as apiSecret from "../apiSecret.json";
const crypto = require("crypto");
import { blackScholes } from 'black-scholes';

export class Router {
  mm_callback: (d: DIPDeposit[]) => void;
  risk_manager_callback: (d: DIPDeposit[]) => void;
  dips: { [name: string]: DIPDeposit };
  token: string;

  constructor(
    mm_callback: (d: DIPDeposit[]) => void,
    risk_manager_callback: (d: DIPDeposit[]) => void,
    token: string
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

    const symbol = `${dip_deposit.splToken},USDC,${date.getUTCFullYear()}-${
      date.getUTCMonth() + 1
    }-${date.getUTCDate()},${dip_deposit.strike * 1_000_000},UPSIDE,E,P`;
    console.log("++++++++++++++++++++++++++++++++++++++++++++++++++++");
    console.log("Routing for", symbol, "Deposit:", dip_deposit, new Date().toUTCString());

    // This happens after sending tokens to a MM. Exit early.
    if (dip_deposit.qty == 0) {
      this.dips[
        this.dip_to_string(dip_deposit.expirationMs / 1_000, dip_deposit.strike)
      ] = dip_deposit;
      console.log("DIP Deposit quantity zero");
      this.run_risk_manager();
      return;
    }
    this.fetchMMOrder(symbol).then(async (order) => {
      // Run the risk manager if there is no MM order
      if (!order || Number(order["remainingQuantity"]) < dip_deposit.qty) {
        this.dips[
          this.dip_to_string(
            dip_deposit.expirationMs / 1_000,
            dip_deposit.strike
          )
        ] = dip_deposit;
        this.run_risk_manager();
        console.log("No remaining quantity", order);
        return;
      }

      const currentPrice = getPythPrice(new PublicKey(tokenToSplMint(dip_deposit.splToken)));
      const fractionOfYear = (Date.now() - dip_deposit.expirationMs) / 365 * 24 * 60 * 60 * 1_000;
      const vol = THEO_VOL_MAP[dip_deposit.splToken] * (1.15 + Math.random() / 10);
      const thresholdPrice = blackScholes(currentPrice, dip_deposit.strike / 1_000_000, fractionOfYear, vol, 0.01, 'call');

      const price = order["price"];
      // TODO: Test this to make sure the decimals are correct on each.
      console.log("MM price:", price, "BVE price:", thresholdPrice);

      if (thresholdPrice > price) {
        // If the price is worse than the BVE, then do not use the MM, treat it
        // like there is no MM bid.
        console.log("Not routing to MM due to price:", thresholdPrice, price);
        this.dips[
          this.dip_to_string(
            dip_deposit.expirationMs / 1_000,
            dip_deposit.strike
          )
        ] = dip_deposit;
        this.run_risk_manager();
        return;
      }

      const client_order_id = "clientOrderId" + Date.now();
      const side = "SELL";
      const quantity = dip_deposit.qty;
      const secret = apiSecret['default'];

      const request = `clientOrderId=${client_order_id}&symbol=${symbol}&price=${price}&quantity=${quantity}&side=${side}`;
      const calculated_hash = crypto
        .createHmac("SHA256", secret)
        .update(Buffer.from(request))
        .digest("hex");

      const data = {
        symbol: symbol,
        price: price,
        quantity: quantity,
        side: side,
        clientOrderId: client_order_id,
        signature: calculated_hash,
      };

      console.log("Creating api order for buy", data);
      const response = await fetch(`${DUAL_API}/orders/createorder`, {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "X-MBX-APIKEY": PROTCOL_API_KEY,
        },
        body: JSON.stringify(data),
      });
      console.log("API response", await response.json());
    });
  }

  run_risk_manager(): void {
    console.log(this.token, "Run Risk Manager:", this.dips);
    this.risk_manager_callback(Object.values(this.dips));
  }

  async fetchMMOrder(symbol: string): Promise<number> {
    // TODO: Lookup in the pricing object on chain
    try {
      const order = (
        await (
          await fetch(`${DUAL_API}/symbols/getprice?symbol=${symbol}`, {
            method: "get",
            headers: { "Content-Type": "application/json" },
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
    connection: Connection
  ): Promise<void> {
    const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
      OPTION_MINT_ADDRESS_SEED,
      strike * 1_000_000,
      expirationSec,
      splMint,
      usdcMintPk,
      dualMarketProgramID
    );
    const mmOptionAccount = await getAssociatedTokenAddress(
      optionMint,
      optionVaultPk
    );
    const balance = await connection.getTokenAccountBalance(mmOptionAccount);

    this.dips[this.dip_to_string(expirationSec, strike)] = {
      splToken: splMintToToken(splMint),
      premiumAsset: "USDC",
      expirationMs: expirationSec * 1_000,
      strike: strike,
      type: "call",
      qty: Number(balance.value.uiAmount),
    };
  }

  dip_to_string(expirationSec: number, strike: number): string {
    return `Expiration:${expirationSec}_Strike:${strike}`;
  }

  async refresh_dips() {
    console.log("Refreshing dips", API_URL);
    const connection: Connection = new Connection(API_URL);
    const programAccountsPromise =
      connection.getProgramAccounts(dualMarketProgramID);

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
          const alreadyPolled: boolean =
            this.dip_to_string(expirationSec, strike) in this.dips;

          // Always run add_dip since it refreshes the values if the subscribe
          // fails. Can fail in devnet because some incorrectly defined DIPs.
          try {
            await this.add_dip(expirationSec, strike, splMint, connection);
          } catch (err) {
            continue;
          }

          if (alreadyPolled) {
            continue;
          }

          const [optionMint] =
            await findProgramAddressWithMintAndStrikeAndExpiration(
              OPTION_MINT_ADDRESS_SEED,
              strike * 1_000_000,
              expiration,
              splMint,
              usdcMintPk,
              dualMarketProgramID
            );
          const mmOptionAccount = await getAssociatedTokenAddress(
            optionMint,
            optionVaultPk
          );

          // Create a poller
          const poller: Poller = new Poller(
            cluster,
            this.token,
            "USD",
            expirationSec,
            strike,
            "call",
            (deposit: DIPDeposit) => {
              this.route(deposit);
            }
          );

          // Start polling for a specific DIP option token account
          poller.subscribe(mmOptionAccount.toBase58());
        }
      }
    });
  }
}
