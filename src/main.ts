import { DIPDeposit } from './common';
import { monthAdj } from './config';
import { Poller } from './poller';
import { Router } from './router';
import { Scalper } from './scalper';

function main() {
    // Create a scalper
    const scalper: Scalper = new Scalper('BTC');

    // Create a router
    const router: Router = new Router(
        (deposit: DIPDeposit) => { console.log('Route to MM'); },

        // TODO: Make this handle multiple DIPs for the same asset
        (deposit: DIPDeposit) => { console.log(deposit); }//scalper.scalperMango([deposit]) },
    );

    // Create a poller
    const poller: Poller = new Poller(
        'mainnet-beta',
        "BTC",
        "USD",
        new Date(Date.UTC(2022, 8, 12, 12, 0, 0, 0)).getTime() / 1000,
        25000,
        "call",
        (deposit: DIPDeposit) => { router.route(deposit); }
    );

    // Start polling for a specific DIP option token account
    poller.subscribe('GoBGzcR8kDTLKwPxhKb7NX3kmmt3mZKBgYwsbYf5hDcF');
}

main();