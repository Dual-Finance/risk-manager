import * as os from "os";
import * as fs from "fs";
import { PublicKey } from "@solana/web3.js";
import { utils } from "@project-serum/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + "/mango-explorer/id.json", "utf-8")
  );
}

// Sleep Time Required
export function sleepTime(period: number) {
  return new Promise(function (resolve) {
    setTimeout(resolve, period * 1_000);
  });
}

export function readBigUInt64LE(buffer: Buffer, offset = 0) {
  const first = buffer[offset];
  const last = buffer[offset + 7];
  if (first === undefined || last === undefined) {
    throw new Error();
  }
  const lo =
    first +
    buffer[++offset] * 2 ** 8 +
    buffer[++offset] * 2 ** 16 +
    buffer[++offset] * 2 ** 24;
  const hi =
    buffer[++offset] +
    buffer[++offset] * 2 ** 8 +
    buffer[++offset] * 2 ** 16 +
    last * 2 ** 24;
  return BigInt(lo) + (BigInt(hi) << BigInt(32));
}

export function parseDipState(buf: Buffer) {
  const strike = Number(readBigUInt64LE(buf, 8));
  const expiration = Number(readBigUInt64LE(buf, 16));
  const splMint = new PublicKey(buf.slice(24, 56));
  const vaultMint = new PublicKey(buf.slice(56, 88));
  const vaultMintBump = Number(buf.readUInt8(88));
  const vaultSpl = new PublicKey(buf.slice(89, 121));
  const vaultSplBump = Number(buf.readUInt8(121));
  const optionMint = new PublicKey(buf.slice(122, 154));
  const optionBump = Number(buf.readUInt8(154));
  const vaultUsdc = new PublicKey(buf.slice(155, 187));
  const vaultUsdcBump = Number(buf.readUInt8(187));
  const usdcMint = new PublicKey(buf.slice(188, 220));
  return {
    strike,
    expiration,
    splMint,
    vaultMint,
    vaultMintBump,
    vaultSpl,
    vaultSplBump,
    optionMint,
    optionBump,
    vaultUsdc,
    vaultUsdcBump,
    usdcMint,
  };
}

export async function findProgramAddressWithMintAndStrikeAndExpiration(
  seed: string,
  strikePrice: number,
  expiration: number,
  splMint: PublicKey,
  usdcMint: PublicKey,
  programId: PublicKey
) {
  return PublicKey.findProgramAddress(
    [
      Buffer.from(utils.bytes.utf8.encode(seed)),
      toBytes(strikePrice),
      toBytes(expiration),
      splMint.toBuffer(),
      usdcMint.toBuffer(),
    ],
    programId
  );
}

export function toBytes(x: number): Uint8Array {
  const y = Math.floor(x / 2 ** 32);
  return Uint8Array.from(
    [y, y << 8, y << 16, y << 24, x, x << 8, x << 16, x << 24].map(
      (z) => z >>> 24
    )
  );
}

export async function getAssociatedTokenAddress(
  mintPk: PublicKey,
  owner: PublicKey
) {
  return Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPk,
    owner
  );
}