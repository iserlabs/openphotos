# Runbook: Publishing the `social.luminance.*` lexicons

Scope: this runbook publishes the lexicon(s) we own —

- `social.luminance.actor.profile` — `packages/lexicons/lexicons/social/luminance/actor/profile.json`

`social.luminance.portfolio.{photo,series}` were **retired 2026-07-28** (zero
records ever existed in the wild) — their schema files were deleted from this
repo and their published `com.atproto.lexicon.schema` records were removed
from the authority repo. See §7 ("Unpublishing `social.luminance.portfolio.*`")
for how that was done; the sections below now apply to `actor.profile` only.

`packages/lexicons/lexicons/com/atproto/**` (`label/defs.json`, `repo/strongRef.json`) is
**vendored** — copies of upstream Bluesky/ATProto lexicons we depend on for refs, not
schemas we author. **Never publish those.** We don't control the `com.atproto`
NSID authority (that's `atproto.com`'s DNS), and publishing under a namespace we
don't own would fail verification (or worse, be actively misleading). Every
command below is scoped to the `social/luminance/` subtree specifically so this
can't happen by accident.

This procedure was verified against the official guide
(<https://atproto.com/guides/publishing-lexicons>), the NSID spec
(<https://atproto.com/specs/nsid>), and the `com.atproto.lexicon.schema` /
`com.atproto.lexicon.resolveLexicon` lexicon definitions in
[bluesky-social/atproto](https://github.com/bluesky-social/atproto), plus the
`goat` CLI's own source ([bluesky-social/goat](https://github.com/bluesky-social/goat))
as the reference implementation of "publish" and "resolve".

## 1. Concepts

- Lexicon schemas are published as ordinary ATProto records: collection
  `com.atproto.lexicon.schema`, record key (`rkey`) = the lexicon's own NSID.
  The record is the lexicon JSON file's contents plus `"$type":
  "com.atproto.lexicon.schema"`.
- **Authority:** an NSID's authority is every segment except the last, written
  in normal (not reversed) DNS order. Given NSID `social.luminance.portfolio.photo`,
  drop the last segment (`photo`) and reverse `social.luminance.portfolio` →
  authority domain `portfolio.luminance.social`. This is exactly what `goat`'s
  `NSID.Authority()` computes, and it's also how the official guide's own
  example works (`edu.university.dept.lab.blogging.getBlogPost` → authority
  `blogging.lab.dept.university.edu`).
- To prove an account is allowed to publish under an authority, that account's
  DID is published in a DNS TXT record at `_lexicon.<authority-domain>`.
- Resolution/verification is a client-side algorithm (DNS TXT → DID document →
  PDS → fetch the record), not (currently) a single public network endpoint —
  see §4.

## 2. DNS TXT records

`social.luminance.actor.profile`'s authority is `social.luminance.actor`
(all-but-last segment, un-reversed) → DNS record name
`_lexicon.actor.luminance.social`.

(Historically a second authority, `social.luminance.portfolio`, existed for
the now-retired `portfolio.{photo,series}` NSIDs, at
`_lexicon.portfolio.luminance.social` — see §7.)

Create the record at your DNS provider for `luminance.social`:

```
_lexicon.actor.luminance.social       TXT   "did=<AUTHORITY_DID>"
```

`<AUTHORITY_DID>` is the DID of whichever ATProto account will hold the
`com.atproto.lexicon.schema` records (Kevin's own account, or a dedicated
account for luminance.social — any account works as long as its DID matches
this TXT record). Note the literal `did=` prefix inside the TXT value.

Verify propagation before publishing:

```bash
dig +short TXT _lexicon.actor.luminance.social
```

Should return `"did=<AUTHORITY_DID>"` (some resolvers show the quotes, some
don't — either is fine).

## 3. Publish — Method A: `goat` (recommended)

`goat` is Bluesky's own CLI for exactly this (<https://github.com/bluesky-social/goat>).

```bash
brew install goat
# or: go install github.com/bluesky-social/goat/cmd/goat@latest
```

Authenticate as the authority account. Use a Bluesky **app password**
(Settings → App Passwords), not the main account password:

```bash
goat account login -u <authority-handle> -p <app-password>
# CI-friendly alternative (no persisted session file):
#   export GOAT_USERNAME=<authority-handle> GOAT_PASSWORD=<app-password>
```

Scope every command to `social/luminance` explicitly — never point `goat lex`
at the bare `packages/lexicons/lexicons/` root, which also contains the
vendored `com/atproto/**` files:

```bash
cd packages/lexicons/lexicons

# Confirms the DNS TXT record above resolves to this account's DID before
# publishing anything. Fails loudly (with copy-pasteable DNS instructions) if not.
goat lex check-dns social/luminance

# Publishes com.atproto.lexicon.schema records for every NSID found under
# social/luminance/ — i.e. exactly our one remaining lexicon, nothing under com/atproto.
goat lex publish social/luminance
```

Output markers: 🟢 newly published, 🟣 updated (only with `--update`/`-u`),
🟠 skipped (identical to what's already published), ⭕ skipped (DNS doesn't
resolve to this account — re-run `check-dns` first).

## 4. Publish — Method B: manual `curl` (no `goat`)

Equivalent to Method A, useful for CI or when `goat` isn't installed. Run from
the repo root.

```bash
export PDS_HOST="https://bsky.social"      # or the authority account's own PDS
export AUTHORITY_HANDLE="<authority-handle>"
export AUTHORITY_PASSWORD="<app-password>" # Bluesky app password

# 1. Authenticate (com.atproto.server.createSession) and capture DID + access token.
SESSION=$(curl -s -X POST "$PDS_HOST/xrpc/com.atproto.server.createSession" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$AUTHORITY_HANDLE" --arg pw "$AUTHORITY_PASSWORD" \
           '{identifier:$id, password:$pw}')")
AUTHORITY_DID=$(echo "$SESSION" | jq -r .did)
ACCESS_JWT=$(echo "$SESSION" | jq -r .accessJwt)

# 2. Publish each lexicon as a com.atproto.lexicon.schema record
#    (com.atproto.repo.putRecord), rkey = the lexicon's own NSID.
#    Listing the file(s) explicitly — not looping the whole lexicons/
#    tree — is what keeps the vendored com/atproto/* files out of this.
for f in \
  packages/lexicons/lexicons/social/luminance/actor/profile.json
do
  NSID=$(jq -r .id "$f")
  BODY=$(jq -n --arg repo "$AUTHORITY_DID" --arg rkey "$NSID" \
             --slurpfile schema "$f" \
             '{repo:$repo, collection:"com.atproto.lexicon.schema", rkey:$rkey,
               record: ($schema[0] + {"$type":"com.atproto.lexicon.schema"})}')
  curl -s -X POST "$PDS_HOST/xrpc/com.atproto.repo.putRecord" \
    -H "Authorization: Bearer $ACCESS_JWT" \
    -H "Content-Type: application/json" \
    -d "$BODY" | jq -c '{uri, cid}'
  echo "published $NSID"
done
```

If the authority account has 2FA/email auth-factor enabled,
`createSession` will require an `authFactorToken` field — check the code
returned and re-run with `{"identifier":..., "password":..., "authFactorToken":"<code>"}`.

## 5. Verify

Preferred — `goat` performs the full DNS → DID → PDS → `getRecord` walk
client-side and checks the record's inclusion proof:

```bash
goat lex resolve social.luminance.actor.profile
```

Manual fallback (same walk, by hand) if `goat` isn't available:

```bash
dig +short TXT _lexicon.actor.luminance.social   # -> "did=<AUTHORITY_DID>"

curl -s "$PDS_HOST/xrpc/com.atproto.repo.getRecord?repo=$AUTHORITY_DID&collection=com.atproto.lexicon.schema&rkey=social.luminance.actor.profile" | jq
```

**A note on `com.atproto.lexicon.resolveLexicon`:** the spec defines this XRPC
query (`GET /xrpc/com.atproto.lexicon.resolveLexicon?nsid=<nsid>`) as the
single-call way to resolve a lexicon, and it's what a future public resolver
service would expose. As of this writing there's no widely-deployed PDS or
AppView implementing it as a public endpoint — the reference resolvers
(`goat lex resolve`, the `@atproto/lexicon-resolver` npm package) do the DNS
→ DID → PDS → `getRecord` walk themselves instead, which is why that's the
verification method above. If a host later exposes the endpoint, the
equivalent call is:

```bash
curl -s "https://<host>/xrpc/com.atproto.lexicon.resolveLexicon?nsid=social.luminance.actor.profile" | jq
```

## 6. Re-publishing after a lexicon change

Any time `packages/lexicons/lexicons/social/luminance/**` changes (and CI's
"lexicon drift check" in `.github/workflows/ci.yml` confirms the change is
committed), re-run §3 or §4 with `goat lex publish --update` (or just re-run
the manual `putRecord` loop — `putRecord` is create-or-update by rkey) so the
published records match what's in the repo.

## 7. Unpublishing `social.luminance.portfolio.*`

`social.luminance.portfolio.photo` and `social.luminance.portfolio.series`
were retired 2026-07-28: zero records of either type ever existed in the
wild, so this was a pure code deletion (mappers, WATCHED/WANTED_COLLECTIONS
entries, schema JSONs) rather than a data migration — see the codebase's B3
task history. `social.opencontent.*` (governed externally at
opencontent.social) is their structural successor. What's left is unpublishing
the two `com.atproto.lexicon.schema` records that were published under the
old `social.luminance.portfolio` authority.

### Delete the two schema records (via `goat lex unpublish`)

`goat` has a dedicated subcommand for exactly this
(`bluesky-social/goat`'s `lex_unpublish.go`): it deletes the published
`com.atproto.lexicon.schema` record for each given NSID from the current
account's repo (and does **not** touch local schema JSON files — those are
already deleted from this repo separately). Authenticate as the same
authority account used in §3, then unpublish both NSIDs in one call:

```bash
goat account login -u <authority-handle> -p <app-password>
# or: export GOAT_USERNAME=<authority-handle> GOAT_PASSWORD=<app-password>

goat lex unpublish social.luminance.portfolio.photo social.luminance.portfolio.series
```

Output markers: 🟢 deleted, 🟠 failed (record didn't exist, or another error —
printed below the marker).

(Manual `curl` equivalent, same auth pattern as §4's Method B, using
`com.atproto.repo.deleteRecord` with `collection:"com.atproto.lexicon.schema"`
and `rkey:"social.luminance.portfolio.photo"` / `"...series"`.)

Confirm both are gone:

```bash
goat lex resolve social.luminance.portfolio.photo    # expect: not found
goat lex resolve social.luminance.portfolio.series   # expect: not found
```

### DNS TXT record: safe to leave, or remove

`_lexicon.portfolio.luminance.social` (the authority TXT record from the old
`social.luminance.portfolio` authority, see §2) has no remaining lexicons to authorize once the two schema records
above are deleted — a stray `did=` TXT record with nothing published under
that authority is inert, not a security or resolution hazard, so it may be
**left to rot harmlessly**. To tidy DNS anyway, remove the
`_lexicon.portfolio.luminance.social` TXT record in Cloudflare (the
`_lexicon.actor.luminance.social` record from §2 must stay — `actor.profile`
is still published).
