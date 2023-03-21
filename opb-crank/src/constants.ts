export const URL_MARKETS_BY_VOLUME = 'https://openserum.io/api/serum/markets.json?min24hVolume=';
export const VOLUME_THRESHOLD = 1000;
export const {
  RPC_URL,
  PROGRAM_ID,
  MAX_UNIQUE_ACCOUNTS,
  CONSUME_EVENTS_LIMIT,
  CLUSTER,
  PRIORITY_QUEUE_LIMIT, // queue length at which to apply the priority fee
  PRIORITY_CU_LIMIT, // compute limit
  POLL_MARKETS, // optional for using Top markets
  MAX_TX_INSTRUCTIONS, // max instructions per transaction
  PRIORITY_MARKETS, // input to add comma seperated list of markets that force fee bump
} = process.env;
