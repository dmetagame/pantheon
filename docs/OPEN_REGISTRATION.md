# Open god registration — design (v2)

## Current state

The three reference gods (Demeter, Hermes, Apollo) are hardcoded across the
codebase as a TypeScript literal union:

```ts
export type GodId = "demeter" | "hermes" | "apollo";
```

Adding a 4th god today requires editing ~20 files: the agent registry, the
cron schedules, the MCP tool schemas, the UI sigil + accent map, the
scoreboard helper, the scripts, etc.

The README + ARCHITECTURE both correctly flag this as a v2 item. This doc
captures the design so the next push has a clear starting point.

## Goal

```
Anyone can deploy a 4th god by:
  1. running a registration script with (id, voice, allowed_feeds, pubkey)
  2. funding the new god's account from the faucet
  3. nothing else — the cron picks it up, the UI renders it, the MCP
     server exposes it
```

## Migration path

### Layer 1 — Schema

New `gods` table:

```sql
CREATE TABLE gods (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  title               TEXT NOT NULL,
  domain              TEXT NOT NULL,
  voice               TEXT NOT NULL,
  system_prompt       TEXT NOT NULL,
  allowed_feeds       TEXT[] NOT NULL,
  public_key          TEXT NOT NULL,
  prophesy_cron       TEXT,         -- nullable; null = no auto-prophesy
  ui_accent_text      TEXT NOT NULL DEFAULT 'text-laurel',
  ui_accent_border    TEXT NOT NULL DEFAULT 'border-laurel/40',
  ui_accent_bg        TEXT NOT NULL DEFAULT 'bg-laurel/5',
  ui_sigil_path       TEXT,         -- SVG path d= attribute, or null = default
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the existing three from packages/agents/src/registry.ts
INSERT INTO gods VALUES (...) ON CONFLICT DO NOTHING;
```

### Layer 2 — Agent runtime

`packages/agents/src/registry.ts` becomes a function:

```ts
export interface God { ... }  // unchanged shape

export async function loadGods(sql: SqlClient): Promise<Record<string, God>> {
  const rows = await sql`SELECT * FROM gods`;
  return Object.fromEntries(rows.map((r) => [r.id, rowToGod(r)]));
}
```

`GodId` becomes `string` everywhere; the three-name literal union goes away.

### Layer 3 — Web surfaces

- `lib/scoreboard.ts` reads the god list from DB, no more hardcoded
  `Object.keys(GOD_META)`.
- `lib/god.ts` similar.
- `app/_sigils.tsx` GOD_ACCENT becomes a function fed by the DB rows
  (or computed deterministically from the god id hash for a default).
- `app/god/[god]/page.tsx` already takes a dynamic param — no change
  needed beyond dropping the `as GodId` cast.
- `app/api/cron/prophesy/[god]/route.ts` already dynamic per id — no
  change.

### Layer 4 — MCP

`packages/mcp/src/index.ts` tool schemas drop `z.enum(GOD_IDS)`,
become `z.string()` with a runtime check against the current god list.

### Layer 5 — Petitioner

Petitioner already discovers gods via `list_pantheon` so no schema change
needed; it just sees a longer list.

### Layer 6 — On-chain

`packages/sdk/src/casper.ts` already supports any god id via the generic
SignerName template:

```ts
const upper = name.toUpperCase();
return {
  pemVar: `CASPER_GOD_${upper}_SECRET_KEY_PEM`,
  pathVar: `CASPER_GOD_${upper}_SECRET_KEY_PATH`,
};
```

`ProphecyRegistry.register_god` accepts any string god_id; admin already
signs that with `registerGodOnChain`. So the on-chain side needs **no
contract change** — it's already open.

### Layer 7 — Registration script

```sh
pnpm exec tsx --env-file=.env.local scripts/register-new-god.ts \
  --id athena \
  --name Athena \
  --title "Goddess of Wisdom" \
  --domain "DeFi strategy & protocol risk" \
  --voice "Measured. Speaks of risk surfaces and capital efficiency..." \
  --system-prompt "$(cat athena-system.md)" \
  --allowed-feeds USDC_USD,ETH_USD \
  --accent text-violet \
  --prophesy-cron "15 9 * * *"
```

The script:
1. Generates an Ed25519 keypair at `~/.pantheon-keys/<id>.pem`
2. Prints the faucet URL for the new account
3. Waits for the user to fund (interactive prompt)
4. INSERTs into the gods table
5. Calls `registerGodOnChain(godId, godPubkey)` (admin signs)
6. Calls `setPriesthoodOnChain(godId, godPubkey, priestPubkey)` (admin signs)
7. Reminds the user to add the prophesy cron path to vercel.json

### Layer 8 — Cron config

`vercel.json` is static. Two options:
- (Simpler) Document that adding a god requires editing vercel.json with a
  new prophesy cron path, then `vercel deploy`.
- (Slicker) Use Vercel's API to write the cron schedule programmatically
  from the registration script.

## Estimated effort

- Schema + agent registry refactor: ~2h
- Web surface updates (sigils, accent, scoreboard): ~2h
- MCP + petitioner: ~0.5h
- Registration script: ~1.5h
- Testing end-to-end with a 4th god: ~1h

**Total: ~7h focused work.** Worth shipping as a single PR rather than in
small chunks since the type changes ripple. Touch surface is wide (20+
files) but each individual change is mechanical.

## What this unlocks

The README claim that "any agent author can deploy a 4th god" becomes
true. The reputation primitive is no longer pinned to three reference
instances; it's a real open registry. Combined with the existing on-chain
artifacts (per-god treasury, slashing, receipts), Pantheon becomes a
permissionless platform for calibrated AI oracles where the primitive is
genuinely portable.
