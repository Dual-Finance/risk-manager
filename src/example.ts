import * as os from 'os';
import * as fs from 'fs';
import {
  Config,
  getMarketByBaseSymbolAndKind,
  getUnixTs,
  GroupConfig,
  MangoClient,
  ZERO_BN,
} from '@blockworks-foundation/mango-client';
import { Keypair, Commitment, Connection } from '@solana/web3.js';
import configFile from './ids.json';
import { Market } from '@project-serum/serum';

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/mango-explorer/id.json', 'utf-8'),
  );
}

async function examplePerp() {
  // setup client
  const config = new Config(configFile);
  const groupConfig = config.getGroupWithName('devnet.2') as GroupConfig;
  const connection = new Connection(
    config.cluster_urls[groupConfig.cluster],
    'processed' as Commitment,
  );
  const client = new MangoClient(connection, groupConfig.mangoProgramId);

  // load group & market
  const perpMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    'SOL',
    'perp',
  );
  const mangoGroup = await client.getMangoGroup(groupConfig.publicKey);
  const perpMarket = await mangoGroup.loadPerpMarket(
    connection,
    perpMarketConfig.marketIndex,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  // Fetch orderbooks
  const bids = await perpMarket.loadBids(connection);
  const asks = await perpMarket.loadAsks(connection);

  // L2 orderbook data
  for (const [price, size] of bids.getL2(20)) {
    console.log(price, size);
  }

  // Place order
  const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
  const mangoAccount = (
    await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey)
  )[0];

  // Place an order that is guaranteed to go on the book and let it auto expire in 5 seconds
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'buy', // or 'sell'
    50,
    1,
    { orderType: 'limit'},
  ); // or 'ioc' or 'postOnly'

}

examplePerp();
