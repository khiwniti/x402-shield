// SettlementScheme "exact" for Solana SPL tokens.
// Client (agent) builds + signs an SPL transferChecked to the merchant's ATA
// and pays its own fee. Server verifies the tx structure + amount + mint +
// recipient and a fresh valid blockhash, then broadcasts. Non-custodial,
// zero gas cost to the merchant.

import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import type { PaymentTerms, SettlementScheme } from "../index.ts";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TRANSFER_CHECKED_TAG = 12; // spl-token instruction index for TransferChecked

export interface ExactPayload {
  /** base64 of a fully-signed (legacy) transaction */
  tx: string;
}

export function solanaExact(network: string): SettlementScheme & {
  buildClientTx: BuildClientTx;
} {
  return {
    id: "exact",
    buildTerms(o) {
      return { ...o, scheme: "exact", network };
    },
    async verify(conn, payload, terms) {
      const p = payload as ExactPayload;
      if (!p || typeof p.tx !== "string") return "missing payload.tx";
      let tx: Transaction;
      try {
        tx = Transaction.from(Buffer.from(p.tx, "base64"));
      } catch {
        return "malformed transaction";
      }
      if (!tx.signatures.length) return "unsigned transaction";
      if (!tx.recentBlockhash) return "missing blockhash";

      // exactly one SPL instruction, TransferChecked, correct mint/recipient/amount
      const ixs = tx.instructions.filter((i) => i.programId.equals(TOKEN_PROGRAM_ID));
      if (ixs.length !== 1 || tx.instructions.length !== 1) return "expected exactly one Token instruction";
      const ix = ixs[0];
      if (ix.data[0] !== TRANSFER_CHECKED_TAG) return "not a TransferChecked instruction";
      // transfer_checked layout: [tag:u8][amount:u64le][decimals:u8]
      const amount = Buffer.from(ix.data).readBigUInt64LE(1).toString();
      if (amount !== terms.amount) return `amount mismatch: got ${amount}, want ${terms.amount}`;

      const source = ix.keys[0].pubkey;
      const mint = ix.keys[1].pubkey;
      const dest = ix.keys[2].pubkey;
      const owner = ix.keys[3].pubkey;
      if (!mint.equals(new PublicKey(terms.asset))) return "wrong mint";
      if (!dest.equals(new PublicKey(terms.payTo))) return "wrong recipient";
      if (!tx.feePayer || !tx.feePayer.equals(owner)) return "owner must be fee payer";

      // fresh blockhash + check the source holds the funds (best-effort preflight)
      const { value: fh } = await conn.isBlockhashValid(tx.recentBlockhash);
      if (!fh) return "stale blockhash";
      const bal = await conn.getTokenAccountBalance(source).catch(() => null);
      if (!bal) return "cannot read payer token account";
      if (BigInt(bal.value.amount) < BigInt(terms.amount)) return "insufficient funds";

      // signatures must be valid
      if (!tx.verifySignatures(false)) return "invalid signature";
      return null;
    },
    async settle(conn, payload) {
      const p = payload as ExactPayload;
      const raw = Buffer.from(p.tx, "base64");
      // preflight simulation runs inside sendRawTransaction; dupes/errors surface here
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
      const latest = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      return sig;
    },
    buildClientTx,
  };
}

export interface BuildClientTx {
  (
    conn: Connection,
    args: {
      payer: PublicKey;            // agent wallet (fee payer + token owner)
      source: PublicKey;           // agent's ATA for `asset`
      terms: Omit<PaymentTerms, "scheme" | "network">;
    },
    sign: (tx: Transaction) => Transaction
  ): Promise<ExactPayload>;
}

/** Agent-side: construct + sign the exact-scheme payment tx. */
export async function buildClientTx(
  conn: Connection,
  args: { payer: PublicKey; source: PublicKey; terms: Omit<PaymentTerms, "scheme" | "network"> },
  sign: (tx: Transaction) => Transaction
): Promise<ExactPayload> {
  const { payer, source, terms } = args;
  const amount = BigInt(terms.amount);
  const data = Buffer.alloc(1 + 8 + 1);
  data[0] = TRANSFER_CHECKED_TAG;
  data.writeBigUInt64LE(amount, 1);
  data[9] = terms.decimals;
  const tx = new Transaction({
    feePayer: payer,
    recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
  }).add({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(terms.asset), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(terms.payTo), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data,
  });
  const signed = sign(tx);
  return { tx: Buffer.from(signed.serialize({ requireAllSignatures: true })).toString("base64") };
}
