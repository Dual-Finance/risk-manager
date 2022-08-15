import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { DIPDeposit, dualMarketProgramID, mmWalletPk, OPTION_MINT_ADDRESS_SEED, usdcMintPk, wsolPk } from "./common";
import { Poller } from "./poller";
import { Router } from "./router";
import { Scalper } from "./scalper";
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getAssociatedTokenAddress,
  parseDipState,
} from "./utils";
import { cluster, scalperWindow } from "./config";

async function main() {
  const connection: Connection = new Connection(clusterApiUrl(cluster));
  // Create a scalper
  const solScalper: Scalper = new Scalper("SOL");

  const solRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log("Route to MM");
    },
    (deposits: DIPDeposit[]) => {
      solScalper.scalperMango(deposits);
    },
    'SOL'
  );

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

      if (splMint.toBase58() == wsolPk.toBase58()) {
        await solRouter.add_dip(expiration, strike, splMint, connection);

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
          "SOL",
          "USD",
          expiration,
          strike,
          "call",
          (deposit: DIPDeposit) => {
            solRouter.route(deposit);
          }
        );

        // Start polling for a specific DIP option token account
        poller.subscribe(mmOptionAccount.toBase58());
      }
    }
  });
  solRouter.run_risk_manager();
  setInterval(() => {
      console.log('Rerun Risk Manager', new Date().toUTCString());
      solRouter.run_risk_manager();
    }, 1_000 * scalperWindow
  );
}

main();
