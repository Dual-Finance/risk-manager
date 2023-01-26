import { DIPDeposit, SYMBOL } from './common';
import Scalper from './scalper';
import Router from './router';
import {
  scalperWindowSec, cluster, productStaggerSec, productStatus,
} from './config';
import { sleepExact } from './utils';

async function main() {
  console.log('Risk Manager Running on', cluster, new Date().toUTCString());

  const symbols: SYMBOL[] = ['SOL', 'BTC', 'ETH', 'MNGO', 'BONK'];

  const scalpers: Map<SYMBOL, Scalper> = new Map(
    symbols.map((symbol) => [symbol, new Scalper(symbol)]),
  );
  const routers: Map<SYMBOL, Router> = new Map(symbols.map((symbol) => [symbol,
    new Router(
      (deposit: DIPDeposit[]) => {
        console.log('Route to MM', deposit);
      },
      (deposits: DIPDeposit[]) => {
        scalpers[symbol].pickAndRunScalper(deposits);
      },
      'SOL',
    ),
  ]));
  for (const [symbol, router] of routers) {
    if (productStatus.get(symbol)) {
      await router.refresh_dips();
      console.log(`Check ${symbol} Position vs MM Quotes ${new Date().toUTCString()}`);
      router.checkMMPrices();
      await sleepExact(productStaggerSec);
    }
  }

  setInterval(async () => {
    try {
      for (const [symbol, router] of routers) {
        if (productStatus.get(symbol)) {
          console.log('------------------------------------------------');
          console.log(`RERUN ${symbol} Risk Manager ${new Date().toUTCString()}`);
          await router.refresh_dips();
          console.log(`Re-Check ${symbol} Position vs MM Quotes ${new Date().toUTCString()}`);
          router.checkMMPrices();
          await sleepExact(productStaggerSec);
        }
      }
    } catch (err) {
      console.log(err);
      console.log(err.stack);
    }
  }, 1_000 * scalperWindowSec);
}

main();
