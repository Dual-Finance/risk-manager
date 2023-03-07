import { PublicKey } from '@solana/web3.js';

export const PROTCOL_API_KEY = '033000e0a1c3a87a4ec58c9ecbc0e41da02fd517e313ec602422a46f5de5dac7';

export const NUM_DIP_ATOMS_PER_TOKEN = 10 ** 6;

export const OPTION_MINT_ADDRESS_SEED = 'option-mint';

export const OPENBOOK_MKT_MAP = new Map<string, string>([
  ['BTC', '3BAKsQd3RuhZKES2DGysMhjBdwjZYKYmxRqnSMtZ4KSN'], ['ETH', 'BbJgE7HZMaDp5NTYvRh5jZSkQPVDTU8ubPFtpogUkEj4'],
  ['SOL', '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'], ['MNGO', '3NnxQvDcZXputNMxaxsGvqiKpqgPfSYXpNigZNFcknmD'],
  ['BONK', '8PhnCfgqpgFM7ZJvttGdBVMXHuU4Q23ACxCvWkbs1M71'], ['ETH', 'BbJgE7HZMaDp5NTYvRh5jZSkQPVDTU8ubPFtpogUkEj4'],
  ['DUAL', 'H6rrYK3SUHF2eguZCyJxnSBMJqjXhUtuaki6PHiutvum'], ['BTC', '3BAKsQd3RuhZKES2DGysMhjBdwjZYKYmxRqnSMtZ4KSN'],
]);

export const MANGO_MKT_MAP = new Map<string, string>([
  ['BTC', 'HwhVGkfsSQ9JSQeQYu2CbkRCLvsh3qRZxG6m4oMVwZpN'],
]);

export const MANGO_ACCOUNT_PK = new PublicKey('EUQQaFnLBaTmjj9tuj4jP5a9byPYcrQ8M6PvkULtMBLD');
export const MANGO_DEMO_PK = new PublicKey('5fEtAwzsXM4bHAT7gf3unPJFKJmQgYnce9L7GCxWTpEd');

export const WSOL_PK = new PublicKey('So11111111111111111111111111111111111111112');
export const BTC_PK = new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');
export const ETH_PK = new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs');
export const MNGO_PK = new PublicKey('MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac');
export const BONK_PK = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
export const DUAL_PK = new PublicKey('DUALa4FC2yREwZ59PHeu1un4wis36vHRv5hWVBmzykCJ');
export const USDC_DEVNET_PK = new PublicKey('HJiQv33nKujRmZQ3sJBSosXgCEmiHs3mG1yd9VcLawPM');
export const USDC_MAINNET_PK = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export const DIP_PROGRAM_ID = new PublicKey('DiPbvUUJkDhV9jFtQsDFnMEMRJyjW5iS6NMwoySiW8ki');
export const OPB_DEVNET_PROGRAM_ID = new PublicKey('EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj');
export const OPB_MAINNET_PROGRAM_ID = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');
export const CHAINLINK_PROGRAM_ID = new PublicKey('cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ');

export const OPTION_VAULT_PK = new PublicKey('9SgZKdeTMaNuEZnhccK2crHxi1grXRmZKQCvNSKgVrCQ');
export const RM_BACKUP_PK = new PublicKey('FCsXUii28gmnKQCZV1vGMZPqF2LCRCr3pqErQcskgr8W');
export const RM_PROD_PK = new PublicKey('CkcJx7Uwgxck5zm3DqUp2N1ikkkoPn2wA8zf7oS4tFSZ');

export const MS_PER_YEAR = 365 * 60 * 60 * 24 * 1_000;
export const SEC_PER_YEAR = 365 * 60 * 60 * 24;
export const SIX_MONTHS_IN_MS = 1_000 * 60 * 60 * 24 * 30 * 6;

export const DIP_STATE_LENGTH = 260;

export const NO_FAIR_VALUE = 0;
export const SUFFICIENT_BOOK_DEPTH = 0;
