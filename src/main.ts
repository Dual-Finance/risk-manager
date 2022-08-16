import { DIPDeposit } from "./common";
import { Router } from "./router";
import { Scalper } from "./scalper";
import { scalperWindow } from "./config";

async function main() {
  // Create scalpers
  const solScalper: Scalper = new Scalper("SOL");
  const btcScalper: Scalper = new Scalper("BTC");
  const ethScalper: Scalper = new Scalper("ETH");

  const solRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log("Route to MM", deposit);
    },
    (deposits: DIPDeposit[]) => {
      solScalper.scalperMango(deposits);
    },
    'SOL'
  );

  const btcRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log("Route to MM", deposit);
    },
    (deposits: DIPDeposit[]) => {
      btcScalper.scalperMango(deposits);
    },
    'BTC'
  );

  const ethRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log("Route to MM", deposit);
    },
    (deposits: DIPDeposit[]) => {
      ethScalper.scalperMango(deposits);
    },
    'ETH'
  );

  await solRouter.refresh_dips();
  solRouter.run_risk_manager();
  await btcRouter.refresh_dips();
  btcRouter.run_risk_manager();
  await ethRouter.refresh_dips();
  ethRouter.run_risk_manager();

  setInterval(async () => {
      console.log('Rerun Risk Manager', new Date().toUTCString());
      await solRouter.refresh_dips();
      solRouter.run_risk_manager();
      await btcRouter.refresh_dips();
      btcRouter.run_risk_manager();
      await ethRouter.refresh_dips();
      ethRouter.run_risk_manager();
    }, 1_000 * scalperWindow
  );
}

main();
