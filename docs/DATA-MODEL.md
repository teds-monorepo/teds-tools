# Data model

## Current shape (localStorage, via `lib/useHubData.js`)

```ts
type ColorHistoryEntry = {
  hex: string; // "#6C8BFF" — the dedupe key
  rgb: { r: number; g: number; b: number };
};

type DB = {
  colorHistory: ColorHistoryEntry[]; // most recent first, capped at 16
};
```

Everything is stored as one JSON blob under `localStorage["teds-tools-data"]`.

Keys written by sections that no longer exist — notes and links, plus the POE
collections (`tradeConfigs`, `makerGroups`, `exchangeCosts`, `duoGroups`,
`tripleGroups`, `poeLeague`) — may still be present in an older blob. They are
passed through untouched on every write and can be ignored safely. The POE
collections moved to `teds-poe`, which keeps its own storage key.

`colorHistory` is read with `db.colorHistory || []` so data saved before it
existed still loads.

## The hook contract

`useHubData()` returns:

```js
{
  ready,        // bool — false until localStorage has been read (avoids SSR mismatch)
  colorHistory, // array, as above
  addColorToHistory({ r, g, b }),   // dedupes by hex, newest first, keeps 16
}
```

**Call the hook once per page.** Each instance holds its own `db`, and every
write persists a whole-object read-modify-write of `teds-tools-data` — two
instances on one page would clobber each other's collections.

Pages only ever call this hook — never `localStorage` directly. This is the
seam to change when moving to a real backend.

Not everything belongs in here: the Event Timeline's holiday list
(`lib/events.js`) is static reference data the user never edits, so it is a
plain imported array rather than a hook-backed collection. Anything the user
creates, edits or deletes goes through the hook.

When a seed writes straight to storage, spread it into the loaded `db`
(`{ ...db, snippets: … }`) rather than replacing it — an object literal
without a key would drop that whole collection.

Keep the write path and the read path in the same place — an earlier
`migrateLegacyKeys()` helper here read and then removed a legacy key whose
name was identical to `DB_KEY`, which deleted the whole database on every
load. Anything that touches these keys must be checked against the constants
above.

## Adding a new entity type (e.g. "Snippets")

1. Extend `DB` in `lib/useHubData.js`: add `snippets: []` to `emptyDB()`.
2. Add `addSnippet` / `removeSnippet` following the `addColorToHistory`
   pattern (validate required fields, generate `id` + `date`,
   `persist({ ...db, snippets: [...] })`).
3. Return the new fields/functions from the hook.
4. Add `app/snippets/page.js` and a nav entry in `components/Header.js`.
5. Nothing else — there is no Home/dashboard view to surface it on, so the
   nav entry is the only place a new entity type appears.

## Moving from localStorage to a real database

Keep the hook's return shape identical so no page/component needs to change.

1. Add a database (Vercel Postgres, Vercel KV, or Supabase are the easiest
   fits for a Vercel deploy).
2. Add API routes for the collections you move, e.g.
   `app/api/snippets/route.js` (`GET`, `POST`) and
   `app/api/snippets/[id]/route.js` (`DELETE`).
3. Rewrite `lib/useHubData.js` internals:
   - On mount, `fetch("/api/...")` instead of reading `localStorage`, set
     `ready` once all requests resolve.
   - Writes become `fetch(..., { method: "POST" })` then update local state
     with the server's response (so the real `id` comes from the DB).
   - Deletes become `fetch(..., { method: "DELETE" })`.
4. If multiple people will use this, add auth and scope every query in the
   API routes to the signed-in user.
