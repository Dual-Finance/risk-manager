import { DIPDeposit } from './common';
import { Poller } from './poller';

function main() {
    // Create a scalper
    // Create a router
    // Create a poller
    const poller: Poller = new Poller(
        'devnet',
        '83hw1MpnoAggNMVungXgafantW976Cy7WLb7HzYUxwqF',
        (DIPDeposit) => { }
    );

    // Connect the router to the scalper

    // Start polling
    poller.subscribe();
}

main();