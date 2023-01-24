import { DUAL_API } from './config';

export async function fetchMMOrder(symbol: string): Promise<number> {
  // TODO: Lookup in the pricing object on chain
  try {
    const url = `${DUAL_API}/symbols/getprice?symbol=${symbol}`;
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