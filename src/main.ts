import { ReadableStreamDefaultController } from 'stream/web';
import { DIPDeposit } from './common';
import { Poller } from './poller';
import { Router } from './router';

function main() {
    // Create a scalper
    // Create a router
    const router: Router = new Router(
        (deposit: DIPDeposit) => { console.log(deposit); },
        (deposit: DIPDeposit) => { console.log(deposit); }
    );

    // Create a poller
    const poller: Poller = new Poller(
        'devnet',
        (deposit: DIPDeposit) => { router.route(deposit); }
    );

    // Connect the router to the scalper

    // Start polling
    poller.subscribe('83hw1MpnoAggNMVungXgafantW976Cy7WLb7HzYUxwqF');
}

main();