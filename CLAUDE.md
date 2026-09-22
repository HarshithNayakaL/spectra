# Working agreements

Standing instructions for anyone — human or agent — committing to this repo.

## Git

- **Push to `main`.** No feature branches, no pull requests unless asked for one
  by name. Work goes to `main` and gets verified there.
- **Commits are authored and committed as the repo owner**, never as an agent.
  No `Co-Authored-By` trailer, no agent name in a commit message, a code
  comment, or anything else that lands in the repository.
- **Commits must show as Verified on GitHub.** Push through the GitHub API
  (`create_or_update_file` / `push_files`), which GitHub signs with its own
  key, rather than `git push` over HTTPS — a local `git push` from an agent
  session signs with a key GitHub does not know and lands as `unknown_key`.
  After pushing, check it:

  ```bash
  curl -s https://api.github.com/repos/HarshithNayakaL/spectra/commits/<sha> \
    | python3 -c "import json,sys; v=json.load(sys.stdin)['commit']['verification']; print(v['verified'], v['reason'])"
  ```

## Before pushing

```bash
npm run check          # typecheck, tests, build
npm run format:check   # prettier
node scripts/build-vercel.mjs   # the Vercel Build Output API bundle
```

A push that turns the live site red costs more than the time these take.

## After pushing — always

The commit is not the deliverable; the running site is. Every push is followed
by three checks against <https://spectra-ai-aeo.vercel.app>:

1. **The deploy actually landed.** Vercel serves the previous build for a
   minute or two after a push, so poll for something the new build contains
   rather than trusting the clock:

   ```bash
   # wait for a string only the new bundle has
   until curl -s https://spectra-ai-aeo.vercel.app/ \
     | grep -oP 'assets/index-[A-Za-z0-9_-]+\.js' | head -1 \
     | xargs -I{} curl -s "https://spectra-ai-aeo.vercel.app/{}" \
     | grep -q "<a string from the change>"; do sleep 15; done
   ```

   The same trick works for CSS (`assets/index-*.css`) and for the API
   (`/api/health`, `/api/journeys/catalogue`).

2. **The feature runs on the live URL**, not just locally: POST a real audit or
   journey and read the response, or drive the page in a browser.

3. **Say what was verified and what was not.** A change that could not be
   exercised live — because a quota is spent, a key is missing, an external
   service is down — is reported as unverified, with the reason. Never as done.

## What this product claims, and therefore must not do

- **No browser, no JavaScript execution.** The Rust crawler uses `reqwest`; the
  TypeScript path uses `undici` via `fetchPublic`. AI crawlers do not run
  JavaScript, so rendering a page would measure something no answer engine ever
  sees, and `javascript_only` would stop being a finding. Playwright is a
  testing tool here, never a crawler.
- **The model never decides a verdict.** It may choose where to go (the journey
  navigator), what to ask (the fan-out expansion) and who the rivals are. Every
  pass, fail, score and outcome is computed from the responses in
  `packages/evaluation`, which is pure and has no model in it.
- **Say what was not measured.** A stage that could not run is reported with its
  reason, never as a zero and never as a silent absence.

## Environment

- `GEMINI_API_KEY` — server-only. Google Search grounding has its own, much
  smaller quota than generation: when it is spent, generation calls still work,
  so the fan-out expansion, the rival naming and the journey navigator keep
  running while live answers and citations do not.
- The live deployment is <https://spectra-ai-aeo.vercel.app>.
