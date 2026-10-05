// x402-shield core: scheme-agnostic paywall engine.
// Minimal x402 "exact" settlement over Solana SPL tokens for agent micropayments.
// To add confidential settlement (phase 2: Token-2022 confidential transfers),
// implement SettlementScheme — verify/settle seam stays identical.

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

export interface PaymentTerms {
  scheme: string;            // settlement scheme id, e.g. "exact"
  network: string;           // e.g. "solana-devnet"
  payTo: string;             // merchant recipient token account (base58 ATA)
  asset: string;             // SPL mint pubkey
  amount: string;            // base units (decimal string, bigint-safe)
  decimals: number;          // token decimals of the mint
  maxTimeoutSeconds: number;
}

export interface PaymentChallenge {
  x402Version: 1;
  accepts: PaymentTerms[];
  error?: string;
}

export interface ClientPayment {
  scheme: string;
  network: string;
  payload: unknown;
}

export interface SettlementScheme {
  id: string;
  buildTerms(o: Omit<PaymentTerms, "scheme" | "network">): PaymentTerms;
  /** Dry-run a client payment: null iff it would settle correctly. Never mutates chain state. */
  verify(conn: Connection, payload: unknown, terms: PaymentTerms): Promise<string | null>;
  /** Finalize on-chain. Returns tx signature. */
  settle(conn: Connection, payload: unknown, terms: PaymentTerms): Promise<string>;
}

export const X_PAYMENT = "x-payment";
export const b64 = (u8: Uint8Array) => Buffer.from(u8).toString("base64");
export const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export type GuardResult =
  | { status: 402; body: PaymentChallenge }
  | { status: 200; payment: { scheme: string; signature: string } };

export async function guard(opts: {
  schemes: SettlementScheme[];
  connection: () => Connection;
  terms: Omit<PaymentTerms, "scheme" | "network">;
  paymentHeader?: string;
}): Promise<GuardResult> {
  const accepts = opts.schemes.map((s) => s.buildTerms(opts.terms));

  if (!opts.paymentHeader) return { status: 402, body: { x402Version: 1, accepts } };

  let cp: ClientPayment;
  try {
    cp = JSON.parse(Buffer.from(opts.paymentHeader, "base64").toString("utf8"));
  } catch {
    return { status: 402, body: { x402Version: 1, accepts, error: "malformed x-payment" } };
  }

  const scheme = opts.schemes.find((s) => s.id === cp.scheme);
  if (!scheme) return { status: 402, body: { x402Version: 1, accepts, error: `unsupported scheme ${cp.scheme}` } };
  if (cp.network !== scheme.buildTerms(opts.terms).network)
    return { status: 402, body: { x402Version: 1, accepts, error: "network mismatch" } };

  const err = await scheme.verify(opts.connection(), cp.payload, scheme.buildTerms(opts.terms));
  if (err) return { status: 402, body: { x402Version: 1, accepts, error: err } };

  let signature: string;
  try {
    signature = await scheme.settle(opts.connection(), cp.payload, scheme.buildTerms(opts.terms));
  } catch (e) {
    // settle failure (e.g. duplicated payment, changed state) → client retries with fresh tx
    const message = e instanceof Error ? e.message : String(e);
    return { status: 402, body: { x402Version: 1, accepts, error: `settle failed: ${message}` } };
  }
  return { status: 200, payment: { scheme: scheme.id, signature } };
}

/** Client-side helper: wrap terms negotiated from a 402 into the header value. */
export function encodePayment(cp: ClientPayment): string {
  return Buffer.from(JSON.stringify(cp), "utf8").toString("base64");
}

export type TxLike = Transaction | VersionedTransaction;
export { Connection, PublicKey, Transaction, VersionedTransaction };
