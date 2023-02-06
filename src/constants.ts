import { PublicKey } from '@solana/web3.js';

export const PROTCOL_API_KEY = '033000e0a1c3a87a4ec58c9ecbc0e41da02fd517e313ec602422a46f5de5dac7';

export const NUM_DIP_ATOMS_PER_TOKEN = 10 ** 6;

export const OPTION_MINT_ADDRESS_SEED = 'option-mint';

export const OPENBOOK_MKT_MAP = new Map<string, string>([
  ['SOL', '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'], ['MNGO', '3NnxQvDcZXputNMxaxsGvqiKpqgPfSYXpNigZNFcknmD'],
  ['BONK', '8PhnCfgqpgFM7ZJvttGdBVMXHuU4Q23ACxCvWkbs1M71'],
]);

export const wsolPk = new PublicKey('So11111111111111111111111111111111111111112');
export const soBtcPk = new PublicKey('9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E');
export const soEthPk = new PublicKey('2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk');
export const mngoPk = new PublicKey('MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac');
export const bonkPk = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
export const usdcDevnetPk = new PublicKey('HJiQv33nKujRmZQ3sJBSosXgCEmiHs3mG1yd9VcLawPM');
export const usdcMainnetPk = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export const dualMarketProgramID = new PublicKey('DiPbvUUJkDhV9jFtQsDFnMEMRJyjW5iS6NMwoySiW8ki');
export const openbookDevnetId = new PublicKey('EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj');
export const openbookMainnetId = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');
export const CHAINLINK_PROGRAM_ID = new PublicKey('cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ');

export const optionVaultPk = new PublicKey('9SgZKdeTMaNuEZnhccK2crHxi1grXRmZKQCvNSKgVrCQ');
export const riskManagerPk = new PublicKey('FCsXUii28gmnKQCZV1vGMZPqF2LCRCr3pqErQcskgr8W');
export const mangoTesterPk = new PublicKey('CkcJx7Uwgxck5zm3DqUp2N1ikkkoPn2wA8zf7oS4tFSZ');

export const MS_PER_YEAR = 365 * 60 * 60 * 24 * 1_000;
export const SEC_PER_YEAR = 365 * 60 * 60 * 24;
export const SIX_MONTHS_IN_MS = 1_000 * 60 * 60 * 24 * 30 * 6;

export const DIP_STATE_LENGTH = 260;

export const NO_FAIR_VALUE = 0;
export const SUFFICIENT_BOOK_DEPTH = 0;
