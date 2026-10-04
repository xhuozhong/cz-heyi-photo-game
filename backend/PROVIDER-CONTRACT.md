# Provider contract

`createLibtvProvider(config)` returns an object implementing the methods below. All LibTV operations use its official CLI only. This adapter never receives wallet private keys or sends blockchain transactions.

Configuration passed by `backend/server.mjs`:

```js
{
  rootDir,       // absolute repository directory
  dataDir,       // absolute private durable runtime directory
  cliPath,       // LIBTV_CLI, or undefined for adapter default
  model,         // LIBTV_MODEL, or adapter default
  enabled,       // PAID_ENABLED === 'true'; false must never submit
  projectUuid,   // dedicated LIBTV_PROJECT_UUID
  accountId,     // expected LIBTV_ACCOUNT_ID, if configured
  generationBudget, // administrator-approved lifetime generation limit
}
```

Methods:

```js
preflight() -> { ready: boolean, reason?: string, provider: 'libtv' }
submit(job) -> { providerJobId: string }
poll(providerJobId, job) -> {
  status: 'pending' | 'succeeded' | 'failed',
  resultPath?: string, // existing absolute local raster image, never URL
  reason?: string,
}
recover?(job) -> { providerJobId: string } | null
```

`preflight` checks enabled, CLI availability, authenticated active member account, selected image model, valid project and a remaining administrator-approved generation reservation. CLI 1.1.3 has no live credit balance query: operators must verify the actual credit balance and model price before approving this budget. Membership alone does not prove sufficient credits. Return public-friendly failure reason; never return credentials or raw CLI output.

Job fields:

```js
{
  id,                   // UUID, stable across process restarts
  idempotencyKey,        // same as id; use a unique deterministic LibTV node name
  inputPath,            // private normalized JPEG on disk
  character,            // 'cz' | 'heyi'
  scene,                // 'terrace' | 'cafe' | 'street'
  options: { gender, body, outfit },
  outputDir,            // private order directory: adapter state/results belong here
}
```

Before calling submit, backend persists `submitting`. Backend never automatically calls submit again after ambiguous timeout/error/crash. If submit cannot prove no generation was requested, return/throw the error normally; backend marks `review_required`. If adapter can locate an existing submission by idempotency key, implement `recover` as a read-only lookup, returning its ID without running a new node. Once `providerJobId` is saved, restarts and retries only call poll.

`poll` may download a completed result through official CLI. It must not rerun generation. Pending is normal. A failed provider generation is retained for manual service/refund handling; a player's retry must never purchase a second generation silently. Backend normalizes the completed raster with sharp, strips metadata and stamps “AI 合成合影”; only the authenticated order holder can fetch it.
