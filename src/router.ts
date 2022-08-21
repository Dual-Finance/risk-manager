import { Connection, PublicKey } from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import { web3 } from "@project-serum/anchor";
import {
  DIPDeposit,
} from "./common";
import {
  API_URL,
  cluster,
  DUAL_API,
  settlementWallet,
  usdcMintPk,
  dualMarketProgramID,
  mmWalletPk,
  OPTION_MINT_ADDRESS_SEED,
  PROTCOL_API_KEY,
} from "./config";
import { Poller } from "./poller";
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getAssociatedTokenAddress,
  parseDipState,
  splMintToToken,
  tokenToSplMint,
} from "./utils";
import fetch from "cross-fetch";
import * as protocolKeypair from "../mm-keypair.json";
import * as apiSecret from "../apiSecret.json";
const crypto = require("crypto");

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
    const symbol = `${dip_deposit.splToken}.USDC.${date.getUTCFullYear()}-${
      date.getUTCMonth() + 1
    }-${date.getUTCDate()}.${dip_deposit.strike}.UPSIDE.A.P`;
    console.log("Routing for", symbol, "Deposit:", dip_deposit);

    // This happens after sending tokens to a MM. Exit early.
    if (dip_deposit.qty == 0) {
      this.dips[
        this.dip_to_string(dip_deposit.expirationMs / 1_000, dip_deposit.strike)
      ] = dip_deposit;
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
        return;
      }

      const client_order_id = "clientOrderId" + Date.now();
      const side = "SELL";
      const price = order["price"];
      const quantity = dip_deposit.qty;
      const secret = apiSecret;

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

      const key = web3.Keypair.fromSecretKey(
        // @ts-ignore
        Uint8Array.from(protocolKeypair.default)
      );
      const connection = new web3.Connection(web3.clusterApiUrl("devnet"));

      const [optionMint] =
        await findProgramAddressWithMintAndStrikeAndExpiration(
          OPTION_MINT_ADDRESS_SEED,
          dip_deposit.strike * 1_000_000,
          dip_deposit.expirationMs / 1_000,
          tokenToSplMint(dip_deposit.splToken),
          usdcMintPk,
          dualMarketProgramID
        );
      const myToken = new splToken.Token(
        connection,
        optionMint,
        splToken.TOKEN_PROGRAM_ID,
        key
      );
      const fromTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
        key.publicKey
      );
      const toTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
        settlementWallet
      );

      const transaction = new web3.Transaction().add(
        splToken.Token.createTransferInstruction(
          splToken.TOKEN_PROGRAM_ID,
          fromTokenAccount.address,
          toTokenAccount.address,
          key.publicKey,
          [],
          Math.floor(dip_deposit.qty * 1_000_000)
        )
      );
      try {
        await web3.sendAndConfirmTransaction(
          connection,
          transaction,
          [key]
        );
      } catch (err) {
        // Do not send the order to the API if the token move fails.
        console.log(err);
        return;
      }

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
      mmWalletPk
    );
    const balance = await connection.getTokenAccountBalance(mmOptionAccount);

    this.dips[this.dip_to_string(expirationSec, strike)] = {
      splToken: splMintToToken(splMint),
      premiumAsset: "USD",
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
        if (durationMs < 0) {
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
            mmWalletPk
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
