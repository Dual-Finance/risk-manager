import { DIPDeposit } from "./common";
import Scalper from "./scalper";
import Router from "./router";
import {
  SCALPER_WINDOW_SEC, CLUSTER, PRODUCT_STAGGER_SEC, CURRENT_SYMBOL,
} from "./config";
import { sleepExact } from "./utils";

async function main() {
  console.log("Risk Manager Running on", CLUSTER, new Date().toUTCString());

  const scalper: Scalper = new Scalper(CURRENT_SYMBOL);
  const router: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log("Route to MM", deposit);
    },
    (deposits: DIPDeposit[]) => {
      scalper.pickAndRunScalper(deposits);
    },
    CURRENT_SYMBOL
  );

  const [pollers, mmAccounts] = await router.refresh_dips_poller_accounts();
  console.log(
    `Check ${CURRENT_SYMBOL} Position vs MM Quotes ${new Date().toUTCString()}`
  );
  await router.checkMMPrices();
  for (let i = 0; i < pollers.length; i++) {
    pollers[i].subscribe(mmAccounts[i]);
  }
  router.run_risk_manager();

  setInterval(async () => {
    try {
      console.log("------------------------------------------------");
      console.log(
        `RERUN ${CURRENT_SYMBOL} Risk Manager ${new Date().toUTCString()}`
      );
      const [pollers, mmAccounts] = await router.refresh_dips_poller_accounts();
      console.log(
        `Re-Check ${CURRENT_SYMBOL} Position vs MM Quotes ${new Date().toUTCString()}`
      );
      await router.checkMMPrices();
      for (let i = 0; i < pollers.length; i++) {
        pollers[i].subscribe(mmAccounts[i]);
      }
      router.run_risk_manager();
      await sleepExact(PRODUCT_STAGGER_SEC);
    } catch (err) {
      console.log(err);
      console.log(err.stack);
    }
  }, 1_000 * SCALPER_WINDOW_SEC);
}

main();
