import { DIPDeposit } from "./common";
import { Router } from "./router";
import { Scalper } from "./scalper";
import { IS_DEV, percentDrift, scalperWindow, cluster, staggerTime } from "./config";
import { sleepExact } from "./utils";

async function main() {
  console.log ('Risk Manager Running on', cluster, new Date().toUTCString())
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
  if (!IS_DEV) {
    await sleepExact(staggerTime);
    await btcRouter.refresh_dips();
    btcRouter.run_risk_manager();
    await sleepExact(staggerTime);
    await ethRouter.refresh_dips();
    ethRouter.run_risk_manager();
  }

  setInterval(async () => {
      console.log('Rerun SOL Risk Manager', new Date().toUTCString());
      try {
        await solRouter.refresh_dips();
        solRouter.run_risk_manager();
      } catch (err) {
        console.log(err);
        console.log(err.stack);
      }
    }, 1_000 * (scalperWindow + (((Math.random()*2) - 1) * scalperWindow * percentDrift))
  );

  if (!IS_DEV) {
    await sleepExact(staggerTime);
    setInterval(async () => {
      console.log('Rerun BTC Risk Manager', new Date().toUTCString());
      try {
        await btcRouter.refresh_dips();
        btcRouter.run_risk_manager();
      } catch (err) {
        console.log(err);
        console.log(err.stack);
      }
    }, 1_000 * (scalperWindow + (((Math.random()*2) - 1) * scalperWindow * percentDrift))
  );
    await sleepExact(staggerTime);
    setInterval(async () => {
      console.log('Rerun ETH Risk Manager', new Date().toUTCString());
      try {
        await ethRouter.refresh_dips();
        ethRouter.run_risk_manager();
      } catch (err) {
        console.log(err);
        console.log(err.stack);
      }
      }, 1_000 * (scalperWindow + (((Math.random()*2) - 1) * scalperWindow * percentDrift))
    );
  }
}

main();
