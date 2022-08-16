import { Connection, PublicKey } from "@solana/web3.js";
import {
  DIPDeposit,
  dualMarketProgramID,
  mmWalletPk,
  usdcMintPk,
  OPTION_MINT_ADDRESS_SEED,
} from "./common";
import { API_URL, cluster } from "./config";
import { Poller } from "./poller";
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getAssociatedTokenAddress,
  parseDipState,
  splMintToToken,
} from "./utils";

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
    // TODO: Check how much there was before to figure out the amount for routing decision
    // Update the dips
    this.dips[this.dip_to_string(dip_deposit.expiration, dip_deposit.strike)] =
      dip_deposit;

    this.run_risk_manager();
  }

  run_risk_manager(): void {
    this.risk_manager_callback(Object.values(this.dips));
  }

  async add_dip(
    expiration: number,
    strike: number,
    splMint: PublicKey,
    connection: Connection
  ): Promise<void> {
    const [optionMint] = await findProgramAddressWithMintAndStrikeAndExpiration(
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
    const balance = await connection.getTokenAccountBalance(mmOptionAccount);

    this.dips[this.dip_to_string(expiration, strike)] = {
      splToken: splMintToToken(splMint),
      premiumAsset: "USD",
      expiration: expiration * 1_000,
      strike: strike,
      type: "call",
      qty: Number(balance.value.uiAmount),
    };
  }

  dip_to_string(expiration: number, strike: number): string {
    return `${expiration}${strike}`;
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
        const { splMint } = dipState;

        const durationMs = expiration * 1_000 - Date.now();
        if (durationMs < 0) {
          continue;
        }

        if (splMintToToken(splMint) == this.token) {
          if (this.dip_to_string(expiration, strike) in this.dips) {
            continue;
          }

          await this.add_dip(expiration, strike, splMint, connection);

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
            expiration,
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
