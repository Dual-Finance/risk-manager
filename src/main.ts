import { DIPDeposit } from './common';
import { monthAdj } from './config';
import { Poller } from './poller';
import { Router } from './router';
import { Scalper } from './scalper';

function main() {
    // Create a scalper
    const scalper: Scalper = new Scalper('SOL');

    // Create a router
    const router: Router = new Router(
        (deposit: DIPDeposit) => { console.log('Route to MM'); },

        // TODO: Make this handle multiple DIPs for the same asset
        (deposit: DIPDeposit) => { console.log(deposit); scalper.scalperMango([deposit]) },
    );

    // Create a poller
    const poller: Poller = new Poller(
        'devnet',
        (deposit: DIPDeposit) => { router.route(deposit); }
    );

    // Connect the router to the scalper

    // Start polling for a specific DIP option token account
    //poller.subscribe('GoBGzcR8kDTLKwPxhKb7NX3kmmt3mZKBgYwsbYf5hDcF');
    router.route({
        splToken: 'SOL',
        premiumAsset: 'USD',
        expiration: 1662984000,
        strike: 42,
        type: 'call',
        qty: 1
      });
}

main();