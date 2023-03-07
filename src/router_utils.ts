import fetch from 'cross-fetch';
import { DUAL_API } from './config';

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

export function dipToString(expirationSec: number, strike: number): string {
  return `Expiration:${expirationSec}_Strike:${strike}`;
}
