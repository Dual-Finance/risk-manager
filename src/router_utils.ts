import fetch from 'cross-fetch';
import { DUAL_API } from './config';
import { CallOrPut } from './common';

export type getPriceResponse = {remainingQuantity: number, price: number };
export async function fetchMMOrder(apiSymbol: string): Promise<getPriceResponse> {
  // TODO: Lookup in the pricing object on chain
  try {
    const url = `${DUAL_API}/symbols/getprice?symbol=${apiSymbol}`;
    const order = (
      await (
        await fetch(url, {
          method: 'get',
          headers: { 'Content-Type': 'application/json' },
        })
      ).json()
    )[0];
    console.log('API Order URL:', url);
    return order;
  } catch (err) {
    return undefined;
  }
}

export function dipToString(expirationSec: number, strike: number, callOrPut: CallOrPut): string {
  const floorExpiration = Math.floor(expirationSec);
  const precisionStrike = Number(strike.toPrecision(6));
  return `Expiration:${floorExpiration}_Strike:${precisionStrike}_Type:${callOrPut}`;
}
