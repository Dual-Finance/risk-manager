import {
  Keypair,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  BlockhashWithExpiryBlockHeight,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { decodeEventQueue, DexInstructions, Market } from '@project-serum/serum';
import { Logger } from 'tslog';
import axios from 'axios';
import {
  getMultipleAccounts, loadMultipleOpenbookMarkets, sleep, chunk, readKeypair,
} from '../utils/utils';
import {
  CLUSTER, CONSUME_EVENTS_LIMIT, MAX_TX_INSTRUCTIONS, MAX_UNIQUE_ACCOUNTS,
  POLL_MARKETS, PRIORITY_CU_LIMIT, PRIORITY_MARKETS, PRIORITY_QUEUE_LIMIT,
  PROGRAM_ID, RPC_URL, URL_MARKETS_BY_VOLUME, VOLUME_THRESHOLD,
} from '../constants';

// Read the alternate markets file if provided
const markets = require('../markets.json');

// TODO: Add to constants files and use caps
const cluster = CLUSTER || 'mainnet';
const interval = 10; // seconds between crank attempts
const maxUniqueAccounts = parseInt(MAX_UNIQUE_ACCOUNTS || '10', 10);
const consumeEventsLimit = new BN(CONSUME_EVENTS_LIMIT || '30');
const priorityMarkets = PRIORITY_MARKETS ? PRIORITY_MARKETS.split(',') : [];
const priorityQueueLimit = parseInt(PRIORITY_QUEUE_LIMIT || '100', 10);
const CuLimit = parseInt(PRIORITY_CU_LIMIT || '50000', 10);
const maxTxInstructions = parseInt(MAX_TX_INSTRUCTIONS || '1', 10);
const serumProgramId = new PublicKey(
  PROGRAM_ID || cluster === 'mainnet'
    ? 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
    : 'EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj',
);
const payer = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));

const log: Logger = new Logger({
  name: 'openbook-cranker', displayFunctionName: false, displayFilePath: 'hidden', minLevel: 'info',
});

// TODO: Remove log line outside of functions
log.info(payer.publicKey.toString());

const connection = new Connection(RPC_URL!, 'processed' as Commitment);

// blockhash loop
let recentBlockhash: BlockhashWithExpiryBlockHeight;
try {
  connection.getLatestBlockhash(
    'finalized',
  ).then((blockhash) => {
    recentBlockhash = blockhash;
  });
} catch (e) {
  log.error(`Couldn't get blockhash: ${e}`);
}
setInterval(async () => {
  // TODO: Move to function, not top level
  try {
    recentBlockhash = await connection.getLatestBlockhash('finalized');
  } catch (e) {
    log.error(`Couldn't get blockhash: ${e}`);
  }
}, 1000);

async function trytoCrank(spotMarkets: Market[]) {
  try {
    const eventQueuePks = spotMarkets.map(
      (market) => market.decoded.eventQueue,
    );

    // pass a minimum Context Slot to GMA
    let minContextSlot = 0;
    const crankInstructionsQueue: TransactionInstruction[] = [];
    const instructionBumpMap = new Map();

    const eventQueueAccts = await getMultipleAccounts(
      connection,
      eventQueuePks,
      'processed',
      minContextSlot,
    );

    // increase the minContextSlot to avoid processing the same slot twice
    minContextSlot = eventQueueAccts[0].context.slot + 1;

    for (let i = 0; i < eventQueueAccts.length; i++) {
      const { accountInfo } = eventQueueAccts[i];
      const events = decodeEventQueue(accountInfo.data);

      if (events.length === 0) {
        continue;
      }

      const accounts: Set<string> = new Set();
      for (const event of events) {
        accounts.add(event.openOrders.toBase58());

        // Limit unique accounts to first 10
        if (accounts.size >= maxUniqueAccounts) {
          break;
        }
      }

      const openOrdersAccounts = [...accounts]
        .map((s) => new PublicKey(s))
        .sort((a, b) => a.toBuffer().swap64().compare(b.toBuffer().swap64()));

      // coinFee & pcFee are redundant for cranking.
      // Instead, we pass spotMarkets[i]['_decoded'].eventQueue
      // using duplicate accounts will reduce transaction size
      // TODO: Remove if unnecessary
      const instr = DexInstructions.consumeEvents({
        market: spotMarkets[i].publicKey,
        eventQueue: spotMarkets[i].decoded.eventQueue,
        coinFee: spotMarkets[i].decoded.eventQueue,
        pcFee: spotMarkets[i].decoded.eventQueue,
        openOrdersAccounts,
        limit: consumeEventsLimit,
        programId: serumProgramId,
      });

      crankInstructionsQueue.push(instr);

      // if the queue is large then add the priority fee
      if (events.length > priorityQueueLimit) {
        instructionBumpMap.set(instr, 1);
      }

      // bump transaction fee if market address is included in PRIORITY_MARKETS env
      if (priorityMarkets.includes(spotMarkets[i].publicKey.toString())) {
        instructionBumpMap.set(instr, 1);
      }

      log.info(`market ${spotMarkets[i].publicKey} creating consume events for ${events.length} events`);
    }

    // send the crank transaction if there are markets that need cranked
    if (crankInstructionsQueue.length > 0) {
      // chunk the instructions to ensure transactions are not too large
      const chunkedCrankInstructions = chunk(crankInstructionsQueue, maxTxInstructions);

      chunkedCrankInstructions.forEach((transactionInstructions) => {
        const crankTransaction = new Transaction({ ...recentBlockhash });

        crankTransaction.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: (CuLimit * maxTxInstructions),
          }),
        );

        crankTransaction.add(...transactionInstructions);

        crankTransaction.sign(payer);

        // send the transaction
        // TODO: Make tx a const
        connection.sendRawTransaction(crankTransaction.serialize(), {
          skipPreflight: true,
          maxRetries: 2,
        }).then((txId) => log.info(`Cranked ${transactionInstructions.length} market(s): ${txId}`));
      });
    }
  } catch (e) {
    if (e instanceof Error) {
      switch (e.message) {
        case 'Minimum context slot has not been reached':
          // lightweight warning message for known "safe" errors
          log.warn(e.message);
          break;
        default:
          log.error(e);
      }
    }
  }
  await sleep(interval * 1000);
  trytoCrank(spotMarkets);
}

async function run() {
  // list of markets to crank
  // TODO: Move to constants and use caps
  let marketsList;
  let count = 0;
  const TotalRetry = 3;
  if (POLL_MARKETS === 'true') {
    while (count < TotalRetry) {
      try {
        log.info(`Fetching markets from OpenSerum API (attempt ${count + 1}). Volume threshold: ${VOLUME_THRESHOLD}`);
        const { data } = await axios.get(
          URL_MARKETS_BY_VOLUME + VOLUME_THRESHOLD,
        );
        marketsList = data;
        break;
      } catch (e) {
        if (count > TotalRetry) {
          log.error(e);
          throw e;
        } else {
          count++;
        }
      }
    }
  } else {
    marketsList = markets[cluster];
  }

  // load selected markets
  const spotMarkets = await loadMultipleOpenbookMarkets(connection, serumProgramId, marketsList);

  log.info('Cranking the following markets');
  marketsList.forEach((m) => log.info(`${m.name}: ${m.address}`));

  trytoCrank(spotMarkets);
}

run();
