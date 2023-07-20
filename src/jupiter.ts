import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { HedgeSide, RouteDetails, SYMBOL } from "./common";
import { Jupiter } from "@jup-ag/core";
import {
  CLUSTER, JUPITER_LIQUIDITY, JUPITER_SEARCH_STEPS, JUPITER_SLIPPAGE_BPS,
  SLIPPAGE_MAX,
} from "./config";
import { JUPITER_EXCLUDED_AMMS } from "./constants";
import { decimalsBaseSPL, splMintToToken, tokenToSplMint } from "./utils";
import JSBI from "jsbi";

export async function getJupiterPrice(
  base: SYMBOL,
  quote: SYMBOL,
  connection: Connection
) {
  console.log(base, "Loading Jupiter For Price");
  const jupiter = await Jupiter.load({
    connection,
    cluster: CLUSTER,
    ammsToExclude: JUPITER_EXCLUDED_AMMS,
  });
  // Check asks
  const inputBuyToken = new PublicKey(tokenToSplMint(quote));
  const outputBuyToken = new PublicKey(tokenToSplMint(base));
  const inBuyAtomsPerToken =
    10 ** decimalsBaseSPL(splMintToToken(inputBuyToken));
  const outBuyAtomsPerToken =
    10 ** decimalsBaseSPL(splMintToToken(outputBuyToken));
  const buyQty = Math.round(JUPITER_LIQUIDITY * inBuyAtomsPerToken);
  const buyRoutes = await jupiter.computeRoutes({
    inputMint: inputBuyToken,
    outputMint: outputBuyToken,
    amount: JSBI.BigInt(buyQty),
    slippageBps: JUPITER_SLIPPAGE_BPS,
    onlyDirectRoutes: false,
  });
  const buyPath = buyRoutes.routesInfos[0];
  const numBuyPath = buyPath.marketInfos.length;
  const inBuyQty =
    JSBI.toNumber(buyPath.marketInfos[0].inAmount) / inBuyAtomsPerToken;
  const outBuyQty =
    JSBI.toNumber(buyPath.marketInfos[numBuyPath - 1].outAmount) /
    outBuyAtomsPerToken;
  const buyPrice = inBuyQty / outBuyQty;

  // Check bids
  const inputSellToken = new PublicKey(tokenToSplMint(base));
  const outputSellToken = new PublicKey(tokenToSplMint(quote));
  const inSellAtomsPerToken =
    10 ** decimalsBaseSPL(splMintToToken(inputSellToken));
  const outSellAtomsPerToken =
    10 ** decimalsBaseSPL(splMintToToken(outputSellToken));
  const sellQty = Math.round(
    (JUPITER_LIQUIDITY * inSellAtomsPerToken) / buyPrice
  );
  const sellRoutes = await jupiter.computeRoutes({
    inputMint: inputSellToken,
    outputMint: outputSellToken,
    amount: JSBI.BigInt(sellQty),
    slippageBps: JUPITER_SLIPPAGE_BPS,
    onlyDirectRoutes: false,
  });
  const sellPath = sellRoutes.routesInfos[0];
  const numSellPath = sellPath.marketInfos.length;
  const inSellQty =
    JSBI.toNumber(sellPath.marketInfos[0].inAmount) / inSellAtomsPerToken;
  const outSellQty =
    JSBI.toNumber(sellPath.marketInfos[numSellPath - 1].outAmount) /
    outSellAtomsPerToken;
  const sellPrice = outSellQty / inSellQty;

  // Calculate midpoint price of aggregtor
  const midPrice = (buyPrice + sellPrice) / 2;
  return midPrice;
}

// Searches for a jupiter route and attempts it. It successful, returns the
// RouteDetails corresponding to the transaction that was executed. It is on the
// caller to catch any errors from the transaction.
export async function jupiterHedge(
  hedgeSide: HedgeSide,
  base: SYMBOL,
  quote: SYMBOL,
  hedgeDelta: number,
  hedgePrice: number,
  jupiter: Jupiter,
  connection: Connection,
  owner: Keypair,
): Promise<RouteDetails> {
  let inputToken: PublicKey;
  let outputToken: PublicKey;
  let hedgeAmount: number;
  if (hedgeSide === HedgeSide.sell) {
    inputToken = new PublicKey(tokenToSplMint(base));
    outputToken = new PublicKey(tokenToSplMint(quote));
    hedgeAmount = Math.abs(hedgeDelta);
  } else {
    inputToken = new PublicKey(tokenToSplMint(quote));
    outputToken = new PublicKey(tokenToSplMint(base));
    hedgeAmount = Math.abs(hedgeDelta) * hedgePrice;
  }
  const inputMaxQty = Math.round(
    hedgeAmount * 10 ** decimalsBaseSPL(splMintToToken(inputToken))
  );

  // Sort through paths of swap qty.
  let routeDetails: RouteDetails;
  let sortFactor = 2;
  let lastSucess: boolean;
  for (let i = 0; i < JUPITER_SEARCH_STEPS; i++) {
    sortFactor += lastSucess ? 1 / 2 ** i : -1 / 2 ** i;
    lastSucess = false;
    const searchQty = Math.round(inputMaxQty * sortFactor);
    const routes = await jupiter.computeRoutes({
      inputMint: inputToken,
      outputMint: outputToken,
      amount: JSBI.BigInt(searchQty),
      slippageBps: SLIPPAGE_MAX.get(base) * 100 * 100,
      onlyDirectRoutes: false,
    });
    const bestRoute = routes.routesInfos[0];
    const numRoutes = bestRoute.marketInfos.length;
    const inAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(inputToken));
    const outAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(outputToken));
    const inQty =
      JSBI.toNumber(bestRoute.marketInfos[0].inAmount) / inAtomsPerToken;
    const outQty =
      JSBI.toNumber(bestRoute.marketInfos[numRoutes - 1].outAmount) /
      outAtomsPerToken;

    const netPrice =
      hedgeSide === HedgeSide.sell ? outQty / inQty : inQty / outQty;
    const venue = bestRoute.marketInfos[numRoutes - 1].amm.label;
    const { swapTransaction } = await jupiter.exchange({
      routeInfo: routes.routesInfos[0],
    });

    if (hedgeSide === HedgeSide.sell) {
      if (netPrice > hedgePrice) {
        const swapQty = -searchQty / inAtomsPerToken;
        routeDetails = {
          price: netPrice,
          qty: swapQty,
          venue,
          swapTransaction,
        };
        lastSucess = true;
        if (i === 0) {
          break;
        }
      }
    } else if (netPrice < hedgePrice) {
      const swapQty = searchQty / inAtomsPerToken / hedgePrice;
      routeDetails = {
        price: netPrice,
        qty: swapQty,
        venue,
        swapTransaction,
      };
      lastSucess = true;
      if (i === 0) {
        break;
      }
    }
  }

  if (routeDetails !== undefined) {
    const { swapTransaction } = routeDetails;
    let txid: string;
    if (swapTransaction instanceof Transaction) {
      txid = await sendAndConfirmTransaction(
        connection,
        swapTransaction,
        [owner],
      );
    } else {
      swapTransaction.sign([owner]);
      const rawTx = swapTransaction.serialize();
      txid = await connection.sendRawTransaction(rawTx);
    }
    console.log(base, 'Jupiter Hedge via', routeDetails.venue, 'price', routeDetails.price, 'qty', routeDetails.qty, `https://solana.fm/tx/${txid}${CLUSTER?.includes('devnet') ? '?cluster=devnet' : ''}`);
  } else {
    console.log(base, 'No Jupiter Route found better than', hedgePrice);
  }

  return routeDetails;
}
