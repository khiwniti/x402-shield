// Real end-to-end: local validator + mock USDC + paywalled HTTP server + paying agent.
// Requires: solana-test-validator running on 127.0.0.1:8899 and the deploy wallet funded.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddress, getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { solanaExact, type ExactPayload } from "../src/schemes/solana-exact.ts";
import { paywall } from "../src/adapters/node-http.ts";
import { encodePayment } from "../src/index.ts";

const RPC = "http://127.0.0.1:8899";
const AMOUNT = "10000"; // 0.01 mock-USDC
const DECIMALS = 6;

function payer() {
  const p = (process.env.HOME ?? "/root") + "/.config/solana/id.json";
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

test("x402 exact-scheme end-to-end payment", { timeout: 120_000 }, async () => {
  const conn = new Connection(RPC, "confirmed");
  const agent = payer();

  // funding on local validator is unlimited
  const sig = await conn.requestAirdrop(agent.publicKey, 5e9);
  await conn.confirmTransaction(sig, "confirmed");

  const mintAuth = Keypair.generate();
  const mint = await createMint(conn, agent, mintAuth.publicKey, null, DECIMALS, undefined, undefined, TOKEN_PROGRAM_ID);

  const merchantAta = await getOrCreateAssociatedTokenAccount(conn, agent, mint, Keypair.generate().publicKey).then(a => a.address);
  const agentAta = (await getOrCreateAssociatedTokenAccount(conn, agent, mint, agent.publicKey)).address;
  await mintTo(conn, agent, mint, agentAta, mintAuth, 1_000_000); // 1.0 mock-USDC

  const scheme = solanaExact("solana-localnet");
  const server: Server = createServer(
    paywall({
      schemes: [scheme],
      connection: () => conn,
      terms: () => ({ maxTimeoutSeconds: 60, payTo: merchantAta.toBase58(), asset: mint.toBase58(), amount: AMOUNT, decimals: DECIMALS }),
      handler: (_req, res, payment) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, paid: payment.signature }));
      },
    })
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object", "server has a port");
  const port = addr.port;

  try {
    // 1) no payment → 402 with terms
    let res = await fetch(`http://127.0.0.1:${port}/premium`);
    assert.equal(res.status, 402);
    const ch = await res.json();
    assert.equal(ch.x402Version, 1);
    const terms = ch.accepts.find((t: any) => t.scheme === "exact");
    assert.equal(terms.amount, AMOUNT);
    assert.equal(terms.payTo, merchantAta.toBase58());

    // 2) pay + retry → 200 with signature, and the merchant actually received funds
    const before = (await getAccount(conn, merchantAta)).amount;
    const payload: ExactPayload = await scheme.buildClientTx(
      conn,
      { payer: agent.publicKey, source: agentAta, terms },
      (tx: Transaction) => { tx.sign(agent); return tx; }
    );
    res = await fetch(`http://127.0.0.1:${port}/premium`, {
      headers: { "x-payment": encodePayment({ scheme: "exact", network: terms.network, payload }) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    await conn.confirmTransaction(body.paid, "confirmed");
    const after = (await getAccount(conn, merchantAta)).amount;
    assert.equal(after - before, BigInt(AMOUNT));

    // 3) garbage header → 402 with error
    res = await fetch(`http://127.0.0.1:${port}/premium`, { headers: { "x-payment": "not-base64-json" } });
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /malformed/);

    // 4) replaying the SAME payment → must NOT pay twice (blockhash replay gate)
    res = await fetch(`http://127.0.0.1:${port}/premium`, {
      headers: { "x-payment": encodePayment({ scheme: "exact", network: terms.network, payload }) },
    });
    assert.equal(res.status, 402);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
