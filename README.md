# Voice Exam

A hands-free, voice-driven exam platform. An admin uploads course material and an AI writes the questions. Students sign in with their wallet, take the exam **by voice**, then pay a small USDC fee to record their result on **Base** and reveal their score. Anyone can look up and verify a result by wallet address.

## How it works

1. **Admin** signs in with the one admin wallet, creates a course and its rules (questions per exam, exam time, seconds per question, repeats allowed).
2. **Admin uploads material**: PDF, Word (`.docx`), PowerPoint (`.pptx`), `.txt`, `.md`, `.html`, `.csv` or images. Scanned pages and images are read with OCR. Each file becomes a *module*.
3. **AI generates questions** from the modules (Gemini). Every question is independently re-answered by the AI and kept only if its answer matches the key. Options are shuffled. Drafts stay hidden until the admin approves them.
4. **Students** connect a wallet, pick a course, and the agent reads each question aloud. After the reading, a countdown starts and the microphone opens. Answers like "option B", "bravo", "the second one" or the answer text itself are understood. "Repeat" re-reads a question (limited by the course rules).
5. **Pay to reveal**: when the exam ends the score is stored but hidden. The student pays **0.10 USDC** through the contract, which records the result hash on Base. The server verifies the payment on-chain, then reveals the score.
6. **Public results** live at `/<wallet address>`, with a Verify button that recomputes the hash and checks it against the blockchain. Only paid results are public.

## Architecture

```
Browser (Web Speech API: speech + recognition, wallet login with an injected wallet)
   |  HTTPS / JSON
Node.js + Express backend ---- Postgres (courses, questions, sessions, results)
   |                       \-- Gemini API (question generation, fuzzy answer matching)
   |  read-only RPC (with failover)
Base mainnet: ResultRegistry contract  --  USDC fee -> treasury, result hash -> chain
```

- **Server-side timing.** The server owns every countdown and rejects late answers. Reading time is credited back to the exam clock but capped, so long questions do not eat answering time and stalling does not buy extra time.
- **The backend never signs transactions.** Students pay their own gas and fee from their wallet. Results are bound to the student's wallet, so nobody else can claim them.
- **No personal data on-chain.** Only a hash is stored.

## Run locally

Requirements: Docker, Node 20+, a browser wallet (MetaMask or similar), Chrome or Edge for voice.

```bash
cp .env.example .env      # fill in ADMIN_WALLET and SESSION_SECRET at minimum
docker compose up -d --build
```

- App: http://localhost:3100 (students) and http://localhost:3100/admin.html (admin)
- Database: Postgres on host port 5439

Configuration is described in [.env.example](.env.example). `GEMINI_API_KEY` is optional: without it the app works, but AI question generation is off.

## Deploy to Render

The app is one Node server plus Postgres, so it runs on Render as a Docker web service. The root [Dockerfile](Dockerfile) builds the backend and the web pages together, and [render.yaml](render.yaml) describes the service and database. The schema is created automatically on first start.

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, pick the repository. Render reads `render.yaml`.
3. When prompted, set `ADMIN_WALLET` (public address), `CONTRACT_ADDRESS` (your deployed ResultRegistry) and optionally `GEMINI_API_KEY`. `SESSION_SECRET` is generated for you. `ANCHOR_PRIVATE_KEY` is **not** needed on Render, because the running app never signs transactions.
4. Open the service URL. It is HTTPS, which browsers require for the microphone and wallet login.

Notes:
- Use a paid web plan for real use. Free services sleep when idle, and OCR plus AI generation need roughly 1 GB of memory. A restart stops a running upload or generation job; the app marks it failed and you simply start it again.
- Render's free Postgres expires after a period. Use a paid database or an external one (Neon, Supabase) and set `DATABASE_SSL=true` with its connection string as `DATABASE_URL`.
- **Vercel is not suitable for the backend.** It runs short-lived serverless functions, while this app needs minutes-long background jobs, uploads larger than Vercel's request limit, and in-memory login state. Host the whole app on Render (or any Docker host).

## Smart contract

`contracts/src/ResultRegistry.sol` takes `(USDC address, treasury, fee)`. A student calls `payAndAnchor(resultHash)`: the fee is pulled to the treasury and the hash is recorded with the payer's address.

```bash
cd contracts && npm install
npx hardhat test
npx hardhat run scripts/deploy.cjs --network base     # spends real ETH from ANCHOR_PRIVATE_KEY's wallet
```

Then put the deployed address in `CONTRACT_ADDRESS` and run `docker compose up -d --force-recreate backend`.

## Tests

```bash
cd backend && npm install && npm test        # answer matching, wallet auth, file extraction, question generation helpers
cd contracts && npx hardhat test             # contract behaviour with a mock USDC
```

`contracts/scripts/local-chain.cjs` deploys a mock USDC and the registry to a local `hardhat node` for end-to-end testing.

## Troubleshooting voice

- **Students: "Test my microphone"** on the start screen shows which microphone the browser uses, your volume level, and what the speech engine heard. Quiet voices are almost always a low input volume or the wrong default microphone.
- **Admin: "Recent voice activity"** at the bottom of the admin page shows what each student's speech engine returned and what the agent decided, plus speech problems reported by the browser.
- Typing an answer always works as a fallback.

## Project layout

```
backend/      Express API, answer-matching agent, AI generation jobs, file extraction (PDF/OCR/DOCX/PPTX)
backend/sql/  Database schema
contracts/    ResultRegistry (Solidity) with Hardhat tests and deploy scripts
public/       Student app, admin app, results pages (plain HTML/JS, no build step)
```

## Security notes

- Keep `.env` out of version control (it is in `.gitignore`). It can hold a deploy key, the Gemini key and the session secret.
- Only the single wallet in `ADMIN_WALLET` gets admin access. Every other wallet is a student.
- Admin uploads are trusted input. Do not expose the admin wallet to untrusted users.
