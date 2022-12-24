import { DIPDeposit } from './common';
import { Router } from './router';
import { Scalper } from './scalper';
import {
  percentDrift, scalperWindow, cluster, staggerTime, productStatus,
} from './config';
import { sleepExact } from './utils';

async function main() {
  console.log('Risk Manager Running on', cluster, new Date().toUTCString());
  // Create scalpers
  const solScalper: Scalper = new Scalper('SOL');
  const btcScalper: Scalper = new Scalper('BTC');
  const ethScalper: Scalper = new Scalper('ETH');
  const mngoScalper: Scalper = new Scalper('MNGO');

  const solRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log('Route to MM', deposit);
    },
    (deposits: DIPDeposit[]) => {
      solScalper.pickAndRunScalper(deposits);
    },
    'SOL',
  );
  // TODO test BTC & ETH after sollet is resolved
  const btcRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log('Route to MM', deposit);
    },
    (deposits: DIPDeposit[]) => {
      btcScalper.pickAndRunScalper(deposits);
    },
    'BTC',
  );

  const ethRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log('Route to MM', deposit);
    },
    (deposits: DIPDeposit[]) => {
      ethScalper.pickAndRunScalper(deposits);
    },
    'ETH',
  );
  const mngoRouter: Router = new Router(
    (deposit: DIPDeposit[]) => {
      console.log('Route to MM', deposit);
    },
    (deposits: DIPDeposit[]) => {
      mngoScalper.pickAndRunScalper(deposits);
    },
    'MNGO',
  );

  if (productStatus.get('SOL')) {
    await solRouter.refresh_dips();
    console.log('Check SOL Position vs MM Quotes', new Date().toUTCString());
    solRouter.checkMMPrices();
    console.log('Run SOL Risk Manager', new Date().toUTCString());
    solRouter.run_risk_manager();
    await sleepExact(staggerTime);
  }
  if (productStatus.get('BTC')) {
    await btcRouter.refresh_dips();
    console.log('Check BTC Position vs MM Quotes', new Date().toUTCString());
    btcRouter.checkMMPrices();
    console.log('Run BTC Risk Manager', new Date().toUTCString());
    btcRouter.run_risk_manager();
    await sleepExact(staggerTime);
  }
  if (productStatus.get('ETH')) {
    await ethRouter.refresh_dips();
    console.log('Check ETH Position vs MM Quotes', new Date().toUTCString());
    ethRouter.checkMMPrices();
    console.log('Run ETH Risk Manager', new Date().toUTCString());
    ethRouter.run_risk_manager();
    await sleepExact(staggerTime);
  }
  if (productStatus.get('MNGO')) {
    await mngoRouter.refresh_dips();
    console.log('Check MNGO Position vs MM Quotes', new Date().toUTCString());
    mngoRouter.checkMMPrices();
    console.log('Run MNGO Risk Manager', new Date().toUTCString());
    mngoRouter.run_risk_manager();
  }

  setInterval(async () => {
    try {
      if (productStatus.get('SOL')) {
        console.log('------------------------------------------------');
        console.log('Re-Check SOL Position vs MM Quotes', new Date().toUTCString());
        solRouter.checkMMPrices();
        console.log('RERUN SOL Risk Manager', new Date().toUTCString());
        await solRouter.refresh_dips();
        solRouter.run_risk_manager();
        await sleepExact(staggerTime);
      }
      if (productStatus.get('BTC')) {
        console.log('------------------------------------------------');
        console.log('Re-Check BTC Position vs MM Quotes', new Date().toUTCString());
        btcRouter.checkMMPrices();
        console.log('RERUN BTC Risk Manager', new Date().toUTCString());
        await btcRouter.refresh_dips();
        btcRouter.run_risk_manager();
        await sleepExact(staggerTime);
      }
      if (productStatus.get('ETH')) {
        console.log('------------------------------------------------');
        console.log('Re-Check ETH Position vs MM Quotes', new Date().toUTCString());
        ethRouter.checkMMPrices();
        console.log('RERUN ETH Risk Manager', new Date().toUTCString());
        await ethRouter.refresh_dips();
        ethRouter.run_risk_manager();
        await sleepExact(staggerTime);
      }
      if (productStatus.get('MNGO')) {
        console.log('------------------------------------------------');
        console.log('Re-Check MNGO Position vs MM Quotes', new Date().toUTCString());
        mngoRouter.checkMMPrices();
        console.log('RERUN MNGO Risk Manager', new Date().toUTCString());
        await mngoRouter.refresh_dips();
        mngoRouter.run_risk_manager();
      }
    } catch (err) {
      console.log(err);
      console.log(err.stack);
    }
  }, 1_000 * (scalperWindow + (((Math.random() * 2) - 1) * scalperWindow * percentDrift) - (2 * staggerTime)));
}

main();
