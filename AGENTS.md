# AGENTS.md

## Repo shape
- Single npm package. There is no workspace/monorepo layer; `package.json` is the main source of truth.
- Runtime code lives in `src/`, operational CLIs in `scripts/`, tests in `test/`, docs/runbooks in `docs/`.
- `public/` and `dist/` are build outputs, not primary sources. The server prefers `dist/public` for static assets, then falls back to `public/`.

## Runtime entrypoints
- `src/index.ts` is the main server entrypoint. It mounts `GET /healthz`, `GET /`, `POST /research`, and `POST /synthesize`.
- `src/frontend/main.tsx` boots `NewsResearchApp`, so article research is the default UI surface. The synthesis console still exists, but only as the secondary “Open synthesis console” mode in `src/frontend/NewsResearchApp.tsx` / `src/frontend/OperatorConsole.tsx`.
- `src/pipeline.ts` contains two different flows:
  - `/research` fetches one article URL, cleans/truncates article HTML, then runs a planner -> pro -> contra sequence.
  - `/synthesize` performs the signed manifest flow over the fixed model set.
- The `/synthesize` model fan-out is intentionally sequential, not parallel, because the gateway/JWT path races under parallel attestation. Do not “optimize” this without re-checking `src/pipeline.ts`.
- `scripts/verify-manifest.ts` is the standalone verifier for saved `/synthesize` responses.
- `scripts/build-frontend.mjs` bundles `src/frontend/main.tsx` to `app.js` in the requested output directory and writes its own `index.html` shell. Keep it in sync with `src/frontend/shell.ts` if UI shell copy changes.

## Commands that matter
- Install: `npm install`
- Local dev: `cp .env.example .env` then `npm run dev`
  - `npm run dev` starts two processes: frontend watch build into `public/` and `tsx watch src/index.ts`.
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Build: `npm run build`
- Live smoke against a deployed app: `APP_URL=http://<host>:3000 npm run e2e:live`
- Offline manifest verification: `npx tsx scripts/verify-manifest.ts response.json`
- Strict verification with refetch + EigenCompute provenance: `npx tsx scripts/verify-manifest.ts response.json --refetch --ecloud --strict`

## Verification order
- CI runs: `npm ci` -> `npm run typecheck` -> `npm test` -> `npm run build`.
- `lint` is not a separate linter here; it is just `tsc --noEmit` again. Do not assume ESLint/Biome/Prettier config exists.
- There is no visible Vitest config file. Test behavior is mostly file-driven; some frontend tests opt into jsdom with per-file headers.

## Environment and deploy quirks
- There is a real Node-version mismatch: `package.json` declares `24.x`, but CI uses Node 25, Docker uses `node:25-alpine`, and the server bundle targets `node25`. Do not trust the `engines` field alone when validating runtime parity.
- Local signing requires `AGENT_PRIVATE_KEY` in `.env`. In EigenCompute, the app can derive signing from `MNEMONIC` and deployment metadata from platform env vars.
- `src/lib/env.ts` loads only the repo-local `.env`, only fills missing env vars, and strips wrapping quotes. Existing process env wins over `.env` values.
- `eigencompute.yaml` binds the app wallet to `AGENT_PRIVATE_KEY` / `AGENT_ID` and names `/research`, `/synthesize`, and `/healthz` as endpoints. `GET /` is still served by the app and is used by live smoke, but it is not a named EigenCompute endpoint.
- For live inference, the repo docs explicitly call for `ecloud compute env set mainnet-alpha` and `EIGEN_GATEWAY_URL=https://ai-gateway.eigencloud.xyz`.
- `FRONTEND_API_BASE_URL` switches the browser UI from same-origin requests to an explicit backend base URL. If you point the local UI at a remote backend, that backend must allow the browser origins via `CORS_ALLOW_ORIGINS`.
- `vercel.json` is frontend-only deployment config: it builds `dist/public` and rewrites `/research`, `/synthesize`, and `/healthz` to a fixed remote backend IP.

## Model / gateway constraints
- The model policy is hard-coded in `src/lib/policy.ts`. If you change model slugs or behavior, keep docs and tests in sync.
- The current fixed model set is Anthropic Sonnet 4.6, OpenAI GPT-4o, and Google Gemini 2.5 Pro, with `MIN_SUCCESS_COUNT = 2`.
- Local/test code should use the repository's mockable gateway path rather than inventing raw HTTP calls; `docs/llm-proxy-notes.md` and `test/llmProxy.test.ts` show the supported pattern.
- `EIGEN_GATEWAY_URL` is the canonical override. `EIGEN_GATEWAY_BASE_URL` still exists only as a fallback alias for older local tooling.
- `scripts/llm-proxy-probe.ts` is the maintenance probe for validating gateway/model behavior when changing model slugs or external gateway assumptions.

## Verifier gotchas
- Save `/synthesize` responses with `?include=raw` if you expect strict verifier replay to pass. Without raw outputs, offline mode can skip merge/raw checks, but `--strict` will fail.
- The verifier supports offline evidence via `--provenance-json`; it does not rely on scraping dashboard HTML.
- `--strict` fails on skipped checks, not just corrupted ones. Expect strict mode to fail if you omit raw outputs or do not provide online/offline provenance inputs.
- The provenance path shells out to `ecloud compute app releases <app-id> --json --full` and `ecloud compute build verify <image-digest> --json`; `app info` text parsing is only used to recover the EVM address.

## Testing boundaries
- Vitest only discovers `test/**/*.test.ts`.
- If you need a focused test run, use Vitest directly, e.g. `npx vitest run test/llmProxy.test.ts`.
- Some tests bind localhost sockets (`test/sourceFetcher.test.ts`, `test/llmProxy.test.ts`), so sandbox/network restrictions can break them even when application logic is fine.
- CLI verifier tests spawn `npx tsx scripts/verify-manifest.ts ...`; keep cwd at repo root when running them.

## Existing docs worth trusting
- `README.md` is the best quick operator overview.
- `docs/verifier.md` is the verifier runbook and should win over looser prose.
- `docs/llm-proxy-notes.md` records the gateway/provider contract used by this repo.
