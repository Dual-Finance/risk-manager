import * as os from 'os';
import * as fs from 'fs';
// @ts-ignore
import * as bs from 'black-scholes';
// @ts-ignore
import * as greeks from 'greeks';
import {
  Config,
  getMarketByBaseSymbolAndKind,
  GroupConfig,
  MangoClient,
  MangoCache,
  BookSide,
  PerpMarket,
  MangoGroup,
  MarketConfig,
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
strike:60, type:'put', qty:10};

let dipArray = []; // Initialize Array to hold all DIP positions

// Iterate by splToken or run seperate instances per
async function scalperPerp() {
  // Setup Client
  const config = new Config(configFile);
  const groupConfig = config.getGroupWithName('devnet.2') as GroupConfig;
  const connection = new Connection(
    config.cluster_urls[groupConfig.cluster],
    'processed' as Commitment,
  );
  const client = new MangoClient(connection, groupConfig.mangoProgramId);

  // Load Group & Market
  const perpMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    dip.splToken,
    'perp',
  );
  const mangoGroup = await client.getMangoGroup(groupConfig.publicKey);

  let perpMarket = await mangoGroup.loadPerpMarket(
    connection,
    perpMarketConfig.marketIndex,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  let [mangoCache] = await loadPrices(mangoGroup, connection, perpMarketConfig);

  // Order Authority
  const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
  const mangoAccount = (
    await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey)
  )[0];

  // Option Parameters
  const rfRate = 0.03;
  let marketIndex = perpMarketConfig.marketIndex;
  let fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
  console.log('Fair Value: ', fairValue)
  const yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000) + (0.5/365);
  const impliedVolMap = new Map<string, number> ([['BTC', 0.60], ['ETH', 0.70], ['SOL', 0.80]]);
  const impliedVol = impliedVolMap.get(dip.splToken);

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
  let hedgeDeltaTotal = mangoDelta + dipDelta;
  console.log('Total Hedge Delta: ', hedgeDeltaTotal)

  // Determine if hedge needs to buy or sell delta
  let hedgeSide;
  hedgeDeltaTotal < 0 ? hedgeSide = 'buy' : hedgeSide = 'sell';
  console.log('Hedge Side ', hedgeSide)

    // Fetch proper orderbook
    const bookSide = hedgeDeltaTotal < 0 ? await perpMarket.loadAsks(connection) : await perpMarket.loadBids(connection);

  // Break up order depending on whether the book can support it
  const maxNotional = 10000; // Max hedging order size of $10,000
  const slippageTolerance = 0.003; // Allow 30bps above/below FMV on limit orders
  const twapInterval = 30; // Number of seconds to space spliced orders across
  let hedgeDeltaClip : number;
  let hedgePrice : number;
  let hedgeCount = 1;
  
  // Delta Hedging Orders
    while (Math.abs(hedgeDeltaTotal*fairValue) > 1){
      hedgeDeltaClip = hedgeDeltaTotal / orderSplice(hedgeDeltaTotal, fairValue, 
        maxNotional, slippageTolerance, bookSide, perpMarket)
      console.log('Hedge', hedgeCount, 'Size:', hedgeDeltaClip)
      hedgePrice = hedgeDeltaTotal < 0 ? fairValue * (1+slippageTolerance) : fairValue * (1-slippageTolerance);
      console.log('Hedge', hedgeCount, 'Price:', hedgePrice)  
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
      // Check if any size left
      if (hedgeDeltaTotal==hedgeDeltaClip){
        console.log('End TWAP')
        break
      }
      // Wait the twapInterval of time before sending updated hedge price & qty
      await twapTime(twapInterval);
      //Update Price
      [mangoCache] = await loadPrices(mangoGroup, connection, perpMarketConfig)
      fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
      // Calc remaining position
      // Todo reduce hedge by what actually got filled
      hedgeDeltaTotal = hedgeDeltaTotal - hedgeDeltaClip;
      console.log('Remaining Size ', hedgeDeltaTotal)
      hedgeCount = hedgeCount + 1;
    }

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

// Splice delta hedge orders if available liquidity not supportive
// Max DIP order size $100k notional so hedge delta < $100K
function orderSplice (qty: number, price: number, notionalMax: number,
   slippage: number, side: BookSide, market: PerpMarket){
  const [_, nativeQty] = market.uiToNativePriceQuantity(0, qty);
  if (qty > 0 && side.getImpactPriceUi(nativeQty) < (price * (1-slippage))){
    console.log('Sell Price Impact: ', side.getImpactPriceUi(nativeQty), 'High Slippage!');
    return Math.max(qty * price / notionalMax, 1)
  }
  else if (qty < 0 && side.getImpactPriceUi(nativeQty) > (price * (1+slippage))) {
    console.log('Buy Price Impact: ', side.getImpactPriceUi(nativeQty), 'High Slippage!')
    return Math.max(qty * price / notionalMax, 1)
  }
  else {
    console.log('Slippage Tolerable', side.getImpactPriceUi(nativeQty))
    return 1
  }
}

// TWAP Time Required
function twapTime(period: number){
  console.log('Wait ', period, 'seconds')
  return new Promise(function(resolve){
    setTimeout(resolve,period*1000)
  });
}

async function loadPrices(mangoGroup: MangoGroup, connection: Connection,
   perpMarketConfig: MarketConfig){
  let [mangoCache]: [
    MangoCache,
  ] = await Promise.all([
    mangoGroup.loadCache(connection),
  ]);
  return [mangoCache]
}
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