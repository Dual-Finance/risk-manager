import * as os from 'os';
import * as fs from 'fs';
// @ts-ignore
import * as bs from 'black-scholes';
// @ts-ignore
import * as greeks from 'greeks';
import {
  Config,
  delistedPerpMarkets,
  getMarketByBaseSymbolAndKind,
  getUnixTs,
  GroupConfig,
  MangoClient,
  MangoCache,
  ZERO_BN,
} from '@blockworks-foundation/mango-client';
import { Keypair, Commitment, Connection } from '@solana/web3.js';
import configFile from './ids.json';

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/mango-explorer/id.json', 'utf-8'),
  );
}

interface DIP {splToken: string; premiumAsset: string; expiration: Date; strike: number; type: string; qty: number}

let dip: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date('2022/12/31'), strike:60, type:'call', qty:10};

async function scalperPerp() {
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
    dip.splToken,
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
  
  const [mangoCache]: [
    MangoCache,
  ] = await Promise.all([
    mangoGroup.loadCache(connection),
  ]);

  const rfRate = 0.03;
  const marketIndex = perpMarketConfig.marketIndex;
  const fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
  const yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000) + (0.5/365);
  const impliedVolMap = new Map<string, number> ([['BTC', 0.60], ['ETH', 0.70], ['SOL', 0.80]]);
  const impliedVol = impliedVolMap.get(dip.splToken);
  console.log(fairValue)
  const positionDelta = greeks.getDelta(
    fairValue,
    dip.strike,
    yearsUntilMaturity,
    impliedVol,
    rfRate,
    dip.type
  )
  let netDelta = positionDelta * dip.qty;
  console.log('Position Delta of ', netDelta)

  // Place order
  const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
  const mangoAccount = (
    await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey)
  )[0];

  // Initial Delta Hedge, if sum(bids/asks) > delta, splice order
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'sell', // or 'sell'
    50,
    netDelta,
    { orderType: 'market'},
  );

  // Calc gamma
  const positionGamma = greeks.getGamma(
    fairValue,
    dip.strike,
    yearsUntilMaturity,
    impliedVol,
    rfRate
  )

  // Calc 1hr Std dev
  let hrStdDev = impliedVol / Math.sqrt(365 * 24);
  let netGamma = positionGamma * dip.qty * hrStdDev * fairValue;
  console.log('Position Gamma of ', netGamma)

  // place bid/offer, start timer
  let gammaBid = fairValue * (1 - hrStdDev)
  let gammaAsk = fairValue * (1 + hrStdDev)
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'buy', // or 'sell'
    gammaBid,
    netGamma,
    { orderType: 'limit'},
  );

  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'sell', // or 'sell'
    fairValue * (1 + hrStdDev),
    netGamma,
    { orderType: 'limit'},
  );
  console.log('Bid', gammaBid)
  console.log('Ask', gammaAsk)
  // listen for fill, replace bid/offer

  // 1 hr elpase, recalc delta, take delta, go to gamma

}

scalperPerp();
