# Paid photo API

This is a separate Node server. GitHub Pages publishes only `public/` and cannot run it. `PAID_ENABLED` defaults false. Real payment is unavailable until an operator deploys this backend with durable private storage, explicit frontend origins, valid BSC RPC and configured LibTV generation budget.

The backend also serves `public/`; its `/paid-config.js` response uses `apiBase: '/'` without changing the source shipped to GitHub Pages. Same-origin deployment is recommended. All API responses use `Cache-Control: no-store`. There are no public order listings and no player photos under `public/`.

## Player journey

1. `GET /api/health`: `{ ready, reason?, chainId: 56, recipient, priceBnb: '0.0014', priceWei: '1400000000000000', provider: 'libtv' }`. Never open a payment prompt unless ready.
2. `POST /api/orders` JSON `{ payerAddress, photoDataUrl, character, scene, options }`: validates a real JPEG/PNG/WebP (12 MiB maximum, 24 MP input maximum, minimum 64×64, no animation), strips metadata and normalizes it to JPEG. Allowed character: `cz`, `heyi`; scene: `terrace`, `cafe`, `street`; options: `gender` male/female, `body` slim/standard/full, `outfit` black/cream/red. Returns 201 with order, `token` and `signatureMessage`. Token is returned once and only its hash is stored. Keep the token locally to restore the order.
3. `POST /api/orders/:id/authorize` Bearer token JSON `{ signature }`: `personal_sign` the exact server message. Message binds service, random nonce, wallet, order, chain, receiver, price, photo SHA-256, selection and expiry. Signature is verified by ethers and only the order payer can authorize. This checks service readiness again and reserves the one available payment/generation slot. Returns `payment: { chainId, to, valueWei, valueHex, data }`.
4. Ask the wallet to send a **native BNB** transaction on chain `0x38`. Use the server's `to`, exact `valueHex` and **unaltered `data`**. The data identifies the order. No token approval or smart contract allowance is requested. The player approves the actual transfer separately in their wallet.
5. `POST /api/orders/:id/payment` Bearer token JSON `{ txHash }`: verifies through the server's configured RPC. Requires chain 56, payer equals signed wallet and tx.from/receipt.from, exact receiver, exact wei, exact order data, successful receipt, transaction newer than authorization and canonical matching block hashes. Credit is granted only after the transaction's block is included in RPC's `finalized` state. Unsupported or failed finality checks fail closed. Returns 202. `paymentStatus: 'pending'` means wait; the backend also rechecks independently after the browser closes.
6. `GET /api/orders/:id` Bearer token restores progress. `completed` includes a relative `resultUrl`. Fetch that URL with the same Bearer token and display the JPEG blob. URLs contain no token.
7. `POST /api/orders/:id/retry` Bearer token JSON `{}` only resumes polling an already submitted provider job or safely locates an existing job. It never buys another generation. `failed` or unresolved `review_required` orders require operator handling using their recorded transaction proof.

POST requests require `Content-Type: application/json` and an Origin exactly listed in `FRONTEND_ORIGINS`. An absent/foreign Origin is rejected. CORS is not authentication; bearer/order signatures and chain proof remain mandatory. Tests and trusted direct clients must set a configured Origin explicitly.

## State and failure rules

States: `awaiting_authorization`, `awaiting_payment`, `queued`, `submitting`, `generating`, `completed`, `failed`, `review_required`.

Each transaction hash can fund exactly one order. Reserving the hash and queued generation is one atomically written ledger change. Provider submission intent is persisted before the first quota-consuming call. Unknown submission outcomes are reviewed or located read-only by stable id; they are never automatically submitted again. Restarting a saved provider job resumes only polling/download. A failed provider generation retains its payment proof and does not trigger another charge or generation.

Authorization expires after 30 minutes by default. A transaction made before expiry can still be claimed later. A confirmed transaction made after expiry is recorded as paid but marked `review_required`, so the receipt is retained for manual fulfilment/refund. This backend has no recipient private key and cannot automatically refund transfers. Submission/poll logs and credentials are not returned by API.

Unsigned uploads are removed after three minutes during maintenance. Authorized unpaid orders without submitted transaction hashes are retained an extra 24 hours, then removed. Unknown hashes exceeding 24 hours move to review and keep evidence. Completed/failed paid orders and the transaction ledger remain durable until operator-managed retention/archive; do not delete the transaction ledger. Inputs are capped at 256 MiB in total, pending unsigned orders at 32, total orders at 10,000; new orders fail closed when a limit is reached. Basic IP limits apply without trusting client-provided forwarding headers.

## Runtime

`createPaidServer({ config, chain?, provider?, autoProcess? })` is exported for tests. It returns `{ server, service, close }`. Production uses `deploy/start-paid.ps1`, `sh deploy/start-paid.sh` or `node --env-file=.env backend/server.mjs` (recommended Node 24). `pnpm run start:paid` only loads environment variables already supplied by the process manager; it does not load `.env` automatically. Ethers and sharp are required; exact dependency versions and `pnpm-lock.yaml` are included.

Environment: `PAID_ENABLED=true`, `BSC_RPC_URL=https://…`, `PAID_DATA_DIR=/private/persistent/path`, `FRONTEND_ORIGINS=https://paid.example`, `HOST=127.0.0.1`, `PORT=4176`, `SERVICE_DOMAIN=paid.example`, plus LibTV configuration in the provider/deployment guide. Bind behind an HTTPS reverse proxy. Forwarding headers are intentionally not trusted, so a single reverse proxy shares the server IP rate limit unless a production rate limiter is added at that proxy.

Use exactly **one backend process and one durable volume**. The file lock rejects concurrent processes using the same data directory; JSON atomic writes/mutexes are not a multi-instance database. Keep storage outside `public/` and out of Git. Backup the full private directory securely, especially `orders.json`, provider journal and order state. Startup refuses unreadable/damaged state rather than resetting used transaction hashes.

Run `npm run test:paid` for fake-RPC/real-signature/provider-stub tests; these tests make no transfer and request no LibTV generation.

Primary references: [ethers personal-message signature recovery](https://docs.ethers.org/v6/api/hashing/#verifyMessage), [ethers provider API](https://docs.ethers.org/v6/api/providers/), [BSC finalized block API](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/).
