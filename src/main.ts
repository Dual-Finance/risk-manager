import { DIPDeposit, SYMBOL } from './common';
import Scalper from './scalper';
import Router from './router';
import {
  SCALPER_WINDOW_SEC, CLUSTER, PRODUCT_STAGGER_SEC, productStatus,
} from './config';
import { sleepExact } from './utils';
import { RM_PROD_PK } from './constants';

async function main() {
  console.log('Risk Manager Running on', CLUSTER, new Date().toUTCString());

  const symbols: SYMBOL[] = ['SOL', 'BTC', 'ETH', 'MNGO', 'BONK', 'DUAL'];

  const scalpers: Map<SYMBOL, Scalper> = new Map(
    symbols.map((symbol) => [symbol, new Scalper(symbol)]),
  );
  const routers: Map<SYMBOL, Router> = new Map(symbols.map((symbol) => [symbol,
    new Router(
      (deposit: DIPDeposit[]) => {
        console.log('Route to MM', deposit);
      },
      (deposits: DIPDeposit[]) => {
        scalpers.get(symbol).pickAndRunScalper(deposits);
      },
      symbol,
    ),
  ]));
  for (const [symbol, router] of routers) {
    if (productStatus.get(symbol)) {
      const pollerSO = await router.refresh_so_poller_accounts();
      // TODO: Check Option Vault instead if we don't route with a fee to RM
      pollerSO.subscribe(RM_PROD_PK.toBase58());
      console.log(symbol, 'POLLER SO', pollerSO);
      const [pollers, mmAccounts] = await router.refresh_dips_poller_accounts();
      console.log(`Check ${symbol} Position vs MM Quotes ${new Date().toUTCString()}`);
      await router.checkMMPrices();
      for (let i = 0; i < pollers.length; i++) {
        pollers[i].subscribe(mmAccounts[i]);
      }
      router.run_risk_manager();
      await sleepExact(PRODUCT_STAGGER_SEC);
    }
  }

  setInterval(async () => {
    try {
      for (const [symbol, router] of routers) {
        if (productStatus.get(symbol)) {
          console.log('------------------------------------------------');
          console.log(`RERUN ${symbol} Risk Manager ${new Date().toUTCString()}`);
          const [pollers, mmAccounts] = await router.refresh_dips_poller_accounts();
          console.log(`Re-Check ${symbol} Position vs MM Quotes ${new Date().toUTCString()}`);
          await router.checkMMPrices();
          for (let i = 0; i < pollers.length; i++) {
            pollers[i].subscribe(mmAccounts[i]);
          }
          router.run_risk_manager();
          await sleepExact(PRODUCT_STAGGER_SEC);
        }
      }
    } catch (err) {
      console.log(err);
      console.log(err.stack);
    }
  }, 1_000 * SCALPER_WINDOW_SEC);
}

main();
