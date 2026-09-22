# Working agreements

Standing instructions for anyone — human or agent — committing to this repo.

## Git

- **Push to `main`.** No feature branches, no pull requests unless asked for one
  by name. Work goes to `main` and gets verified there.
- **Commits are authored and committed as the repo owner**, never as an agent.
  No `Co-Authored-By` trailer, no agent name in a commit message, a code
  comment, or anything else that lands in the repository.
- **Commits must show as Verified on GitHub.** Use `git push`, not the GitHub
  API. Measured, not assumed:

  | How the commit was made             | `verification.reason`                          |
  | ----------------------------------- | ---------------------------------------------- |
  | `git push` from an agent session    | `unknown_key` — signed, key not on the account |
  | `create_or_update_file` via the API | `unsigned` — GitHub does not sign it           |

  An `unknown_key` commit becomes Verified the moment the signing key is added
  to the account; an `unsigned` one never can. So push with git, and register
  the session's SSH signing key once under **Settings → SSH and GPG keys → New
  SSH key**, with **Key type: Signing Key**.

  Get the key the session is actually signing with — the configured
  `user.signingkey` file can be empty because the key lives in the signing
  helper, so read it out of a commit's own signature:

  ```bash
  git cat-file -p HEAD | python3 -c "
  import sys, base64, struct
  raw = sys.stdin.read()
  b64 = ''.join(l.strip() for l in raw[raw.index('-----BEGIN SSH SIGNATURE-----'):
                                       raw.index('-----END SSH SIGNATURE-----')].split(chr(10))[1:])
  blob = base64.b64decode(b64); off = 10
  klen = struct.unpack('>I', blob[off:off+4])[0]; off += 4
  pub = blob[off:off+klen]
  tl = struct.unpack('>I', pub[0:4])[0]
  print(pub[4:4+tl].decode(), base64.b64encode(pub).decode())"
  ```

  Then confirm, and say the result rather than assuming it:

  ```bash
  curl -s https://api.github.com/repos/HarshithNayakaL/spectra/commits/<sha> \
    | python3 -c "import json,sys; v=json.load(sys.stdin)['commit']['verification']; print(v['verified'], v['reason'])"
  ```

  If a session's commits come back `unknown_key` again, that session is signing
  with a different key: read it out as above and add that one too.

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
