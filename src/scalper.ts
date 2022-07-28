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
  BN,
} from '@blockworks-foundation/mango-client';
import { Keypair, Commitment, Connection } from '@solana/web3.js';
import configFile from './ids.json';

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/mango-explorer/id.json', 'utf-8'),
  );
}

// TODO Risk Manager feeds in new DIP position automatically
// Example for Hedging and Scalping a single hardcoded DIP
interface DIP {splToken: string; premiumAsset: string; expiration: Date; 
  strike: number; type: string; qty: number}
let dip: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date('2022/12/31'), 
strike:60, type:'call', qty:10};

let dipArray = []; // Initialize Array to hold all DIP positions

// Iterate by splToken or run seperate instances per
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
  
  const [mangoCache]: [
    MangoCache,
  ] = await Promise.all([
    mangoGroup.loadCache(connection),
  ]);

  // Order Authority
  const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
  const mangoAccount = (
    await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey)
  )[0];

  // Fetch orderbooks
  const bids = await perpMarket.loadBids(connection);
  const asks = await perpMarket.loadAsks(connection);

  // // L2 orderbook data
  // for (const [price, size] of bids.getL2(20)) {
  //   console.log(price, size);
  // }

  // Option Parameters
  const rfRate = 0.03;
  const marketIndex = perpMarketConfig.marketIndex;
  const fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
  const yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000) + (0.5/365);
  const impliedVolMap = new Map<string, number> ([['BTC', 0.60], ['ETH', 0.70], ['SOL', 0.80]]);
  const impliedVol = impliedVolMap.get(dip.splToken);
  console.log('Fair Value: ', fairValue)

  // DELTA HEDGING //
  // Add new DIP to DIP Position Array 
  dipArray.push(dip);
  // TODO Initially calc dip array delta and add to new DIP OR recalc total each run

  // Calc DIP delta for new position
  const positionDelta = greeks.getDelta(
    fairValue,
    dip.strike,
    yearsUntilMaturity,
    impliedVol,
    rfRate,
    dip.type
  )
  let dipDelta = positionDelta * dip.qty; // + existing position DIP delta
  console.log('DIP Delta: ', dipDelta)

  // Get Mango delta position
  const perpAccount = mangoAccount.perpAccounts[marketIndex];
  const mangoDelta = perpAccount.getBasePositionUi(perpMarket);
  console.log('Mango Delta: ', mangoDelta)
  
  // Get total Delta Position to hedge
  const hedgeDeltaTotal = mangoDelta + dipDelta;

  // Calc whether the order book can support the size order
  const [_, nativeQuantity] = perpMarket.uiToNativePriceQuantity(0, hedgeDeltaTotal);
  const sizeReduction = 2; // TODO add logic based off order book depth
  const slippageTolerance = 0.005; // Allow 50bps above/below FMV on limit orders
  let hedgeDeltaClip : number;
  if (dipDelta > 0 && bids.getImpactPriceUi(nativeQuantity) < (fairValue * (1-slippageTolerance))) {
    console.log('Sell Price Impact: ', bids.getImpactPriceUi(nativeQuantity));
    hedgeDeltaClip = hedgeDeltaTotal / sizeReduction;
  }
  else if (dipDelta < 0 && asks.getImpactPriceUi(nativeQuantity) > (fairValue * (1+slippageTolerance))) {
    console.log('Buy Price Impact: ', asks.getImpactPriceUi(nativeQuantity))
    hedgeDeltaClip = hedgeDeltaTotal / sizeReduction;
  }
  else {
    console.log('Slippage Tolerable', asks.getImpactPriceUi(nativeQuantity))
    hedgeDeltaClip = hedgeDeltaTotal;
  }
  console.log('Hedge Delta Clip:', hedgeDeltaClip)

  // Determine if hedge needs to buy or sell delta
  let hedgeSide;
  hedgeDeltaTotal < 0 ? hedgeSide = 'buy' : hedgeSide = 'sell';
  console.log('Hedge Side ', hedgeSide)

  const twapInterval = 10; // Number of seconds to space spliced orders across
  let hedgePrice = hedgeDeltaTotal < 0 ? fairValue * (1+slippageTolerance) : fairValue * (1-slippageTolerance);
  console.log('Hedge Price ', hedgePrice)
  // Delta Hedging Orders
  // TODO iterate order over sizeReduction & twapInterval, recalc hedgePrice
    //for (let i=0; i < sizeReduction; i++){  
      await client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        owner,
        hedgeSide,
        hedgePrice,
        Math.abs(hedgeDeltaClip),
        { orderType: 'limit'},
      );
      // Wait for the twapInterval of time before sending next order
      // sleep(twapInterval);
    //}

  // GAMMA SCALPING //
  // Calc gamma of DIP array
  const positionGamma = greeks.getGamma(
    fairValue,
    dip.strike,
    yearsUntilMaturity,
    impliedVol,
    rfRate
  )

  // Calc 1hr Std dev for gamma levels
  let hrStdDev = impliedVol / Math.sqrt(365 * 24);
  let netGamma = positionGamma * dip.qty * hrStdDev * fairValue;
  console.log('Position Gamma of ', netGamma)

  // Place Gamma scalp bid & offer
  let gammaBid = fairValue * (1 - hrStdDev)
  let gammaAsk = fairValue * (1 + hrStdDev)
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'buy',
    gammaBid,
    netGamma,
    { orderType: 'limit'},
  );
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'sell',
    fairValue * (1 + hrStdDev),
    netGamma,
    { orderType: 'limit'},
  );
  console.log('Bid', gammaBid)
  console.log('Ask', gammaAsk)

  // Start 1 hour timer

}

scalperPerp();

// Recieve DIP token balance change
// addDIP()
// scalperPerp()

// Receive order fill from gamma levels
// scalperPerp()

// 1 Hour Timer Expires
// scalperPerp()

// DIP Expires
// removeDIP()
// scalperPerp()