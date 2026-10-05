// Demo agent: requests a paid endpoint, pays with its own SPL balance, retries.
// Run: RPC=http://127.0.0.1:8899 AGENT_KEY=~/.config/solana/id.json AGENT_ATA=... URL=http://127.0.0.1:4021/demo node --experimental-strip-types demo/agent.ts

import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { solanaExact, type ExactPayload } from "../src/schemes/solana-exact.ts";
import { encodePayment } from "../src/index.ts";

const rpc = process.env.RPC ?? "http://127.0.0.1:8899";
const url = process.env.URL ?? "http://127.0.0.1:4021/";
const keyPath = (process.env.AGENT_KEY ?? "~/.config/solana/id.json").replace(/^~/, process.env.HOME!);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const agentAta = new PublicKey(process.env.AGENT_ATA!);

const conn = new Connection(rpc, "confirmed");
const exact = solanaExact("solana-localnet");

async function run() {
  let res = await fetch(url);
  if (res.status !== 402) {
    console.log("unexpected status", res.status, await res.text());
    process.exit(1);
  }
  const ch = await res.json();
  const terms = ch.accepts.find((t: any) => t.scheme === "exact");
  console.log("402 terms:", JSON.stringify(terms));

  const payload: ExactPayload = await exact.buildClientTx(
    conn,
    { payer: payer.publicKey, source: agentAta, terms },
    (tx: Transaction) => { tx.sign(payer); return tx; }
  );
  const header = encodePayment({ scheme: "exact", network: terms.network, payload });

  res = await fetch(url, { headers: { [("x-payment" as const)]: header } });
  console.log("status:", res.status, "body:", await res.text());
}

run().catch((e) => { console.error(e.message); process.exit(1); });
