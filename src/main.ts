import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { DIPDeposit } from "./common";
import { Poller } from "./poller";
import { Router } from "./router";
import { Scalper } from "./scalper";
import {
  findProgramAddressWithMintAndStrikeAndExpiration,
  getAssociatedTokenAddress,
  parseDipState,
} from "./utils";
import { cluster, scalperWindow } from "./config";

function main() {
  const dualMarketProgramID = new PublicKey(
    "DiPbvUUJkDhV9jFtQsDFnMEMRJyjW5iS6NMwoySiW8ki"
  );
  const usdcMintPk = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const mmWalletPk = new PublicKey(
    "9SgZKdeTMaNuEZnhccK2crHxi1grXRmZKQCvNSKgVrCQ"
  );
  const OPTION_MINT_ADDRESS_SEED = "option-mint";
  const wsolPk = new PublicKey("So11111111111111111111111111111111111111112");
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
  programAccountsPromise.then(async (data) => {
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
        await solRouter.add_dip(expiration, strike);

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
