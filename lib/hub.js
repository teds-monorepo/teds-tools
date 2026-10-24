/**
 * Pure helpers for the Notes and Links export files.
 *
 * Each tab's Export .json writes its list back out through `buildNotesFile` /
 * `buildLinksFile`, so a download is a readable backup and a paste-ready
 * source for the seed in `lib/useHubData.js`.
 *
 * Ids and dates are deliberately not part of the file: the data layer stamps
 * `cryptoId()` and `todayStr()` on each seeded row, so a file never carries two
 * rows with the same id and no date is frozen into it.
 */

export const NOTES_FILE = 'notes.json';
export const LINKS_FILE = 'links.json';

/** The notes in that file's shape, so a download can replace it. */
export function buildNotesFile(notes) {
  return (notes || []).map((note) => ({
    title: note.title,
    body: note.body || '',
    tag: note.tag || '',
  }));
}

/** The links in that file's shape, so a download can replace it. */
export function buildLinksFile(links) {
  return (links || []).map((link) => ({ name: link.name, url: link.url }));
}
