import * as os from 'os';
import * as fs from 'fs';
import {
  AccountInfo,
  Commitment,
  Connection,
  PublicKey,
  PublicKeyInitData,
} from '@solana/web3.js';

import * as fzstd from 'fzstd';
import { Market } from '@project-serum/serum';
import * as bufferLayout from 'buffer-layout';

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk(array, size) {
  return Array.apply(0, new Array(Math.ceil(array.length / size)))
    .map((_, index) => array.slice(index * size, (index + 1) * size));
}

export async function getMultipleAccounts(
  connection: Connection,
  publicKeys: PublicKey[],
  commitment?: Commitment,
  minContextSlot?: number,
): Promise<{
  publicKey: PublicKey;
  context: { slot: number };
  accountInfo: AccountInfo<Buffer>;
}[]> {
  if (!publicKeys.length) {
    throw new Error('no Public Keys provided to getMultipleAccounts');
  }

  // set the maximum number of accounts per call
  const chunkedPks = chunk(publicKeys, 100);

  // asynchronously fetch each chunk of accounts and combine the results
  return (await Promise.all(chunkedPks.map(async (pkChunk) => {
    // use zstd to compress large responses
    const encoding = 'base64+zstd';

    const args = [pkChunk, { commitment, encoding, minContextSlot }];

    // TODO: Use getMultipleAccounts()
    // @ts-ignore
    // eslint-disable-next-line no-underscore-dangle
    const gmaResult = await connection._rpcRequest('getMultipleAccounts', args);

    if (gmaResult.error) {
      throw new Error(gmaResult.error.message);
    }

    return gmaResult.result.value.map(
      ({
        data, executable, lamports, owner,
      }, i) => ({
        publicKey: pkChunk[i],
        context: gmaResult.result.context,
        accountInfo: {
          data: Buffer.from(fzstd.decompress(Buffer.from(data[0], 'base64'))),
          executable,
          owner: new PublicKey(owner),
          lamports,
        },
      }),
    );
  }))).flat();
}

// load multiple markets at once instead of calling getAccountInfo
// for each market 3 times by default it is 1 call to get the market
// and 2 calls to get the decimals for baseMint and quoteMint
// this can be condensed into 2 calls total per 100 markets
export async function loadMultipleOpenbookMarkets(
  connection: Connection,
  programId: PublicKey,
  marketsList: Market[],
) {
  const marketsMap = new Map();
  const decimalMap = new Map();
  const uniqueMints = new Set();

  // get all the market data for an openbook market
  const pubKeys = marketsList.map((item) => new PublicKey(item.address));
  // TODO: Use RPC instead of chunking helper
  const marketsAccountInfos = await getMultipleAccounts(connection, pubKeys, 'processed');
  marketsAccountInfos.forEach((result) => {
    const layout = Market.getLayout(programId);
    const decoded = layout.decode(result.accountInfo.data);
    uniqueMints.add(decoded.baseMint.toString());
    uniqueMints.add(decoded.quoteMint.toString());
    marketsMap.set(result.publicKey.toString(), {
      decoded,
      baseMint: decoded.baseMint,
      quoteMint: decoded.quoteMint,
      programId,
    });
  });

  // TODO: Move to the top outside fct
  // get all the token's decimal values
  const MINT_LAYOUT = bufferLayout.struct([bufferLayout.blob(44), bufferLayout.u8('decimals'), bufferLayout.blob(37)]);
  const uniqueMintsPubKeys = Array.from(uniqueMints).map((mint) => new PublicKey(
    <PublicKeyInitData>mint,
  ));
  const uniqueMintsAccountInfos = await getMultipleAccounts(connection, uniqueMintsPubKeys, 'processed');
  // TODO: Use helper mint fct
  uniqueMintsAccountInfos.forEach((result) => {
    const { decimals } = MINT_LAYOUT.decode(result.accountInfo.data);
    decimalMap.set(result.publicKey.toString(), decimals);
  });

  // loop back through the markets and load the market with
  // the decoded data and the base/quote decimals
  const spotMarkets: Market[] = [];
  marketsMap.forEach((market) => {
    const baseMint = market.baseMint.toString();
    const quoteMint = market.quoteMint.toString();
    const openbookMarket = new Market(
      market.decoded,
      decimalMap.get(baseMint),
      decimalMap.get(quoteMint),
      {},
      programId,
      null,
    );
    spotMarkets.push(openbookMarket);
  });

  return spotMarkets;
}

export function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR
    || fs.readFileSync(`${os.homedir()}/mango-explorer/id.json`, 'utf-8'),
  );
}
