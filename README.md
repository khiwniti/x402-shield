# x402-shield

Drop-in paywall for any Node HTTP server: charge AI agents per request over **x402 on Solana**.
Non-custodial — the agent pays its own gas; the facilitator (you) never touches funds.
Design goal: zero added infra for the seller, one middleware wrap for any route.

```ts
import { createServer } from "node:http";
import { Connection } from "@solana/web3.js";
import { solanaExact } from "x402-shield/schemes/solana-exact.ts";
import { paywall } from "x402-shield/adapters/node-http.ts";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");

createServer(paywall({
  schemes: [solanaExact("solana-devnet")],
  connection: () => conn,
  terms: () => ({ payTo: MERCHANT_ATA, asset: USDC_MINT, amount: "10000", decimals: 6, maxTimeoutSeconds: 60 }),
  handler: (req, res, payment) => res.end(JSON.stringify({ data: "premium", paid: payment.signature })),
})).listen(4021);
```

Agent side: `buildClientTx` + `encodePayment` turn the 402 challenge into a signed
SPL `TransferChecked` — verified on the server (amount, recipient, mint, fresh
blockhash, signatures), then settled with plain preflight.

## Schemes
| scheme | status | notes |
|---|---|---|
| `exact` | ✅ implemented | SPL TransferChecked, agent pays own fee |
| `confidential` | 🔜 phase 2 | Token-2022 confidential transfers behind the same `SettlementScheme` interface — hidden amounts per transaction |

## Verification
`npm test` spins against `solana-test-validator`: creates a mock USDC mint, funds an
agent wallet, runs a paywalled server, and asserts
1. no payment → 402 with exact terms,
2. paying → 200 + real land signature, merchant balance +amount,
3. malformed `x-payment` header → 402 with error,
4. replaying the identical paid transaction → 402 (duplicate-settle gate).

Also proven live on **devnet** (see `../SPRINT.md` / companion repo airdrop-claim for
deploy pattern and explorer signatures).

## Demo
```bash
solana-test-validator --reset --quiet    # any RPC works; default local
npm install
RPC=http://127.0.0.1:8899 MERCHANT_ATA=<ata> MINT=<mint> npm run demo:server &
AGENT_ATA=<agent-ata> npm run demo:agent                            # 402 → pays → 200
```
