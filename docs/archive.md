# archive.org as a source

`src/api/archive.ts` is Internet Archive behind the same `SourceProvider` seam as every other
source. It is always registered: no host, no token, no configuration.

## What an item is

archive.org has two shapes, and they are not interchangeable:

| shape | what it holds | how it is read |
| --- | --- | --- |
| **scanned book** | *leaves* (`imagecount`) | `/download/{id}/page/n{i}_w1200.jpg` |
| **bundle** | book files (`.cbz`, `.cbr`, `.pdf`) | one chapter per volume; pages are that file's zip members |

A bundle answers the leaf route with **200 and the same placeholder for every index**, so a client
that discovers the end by probing never reaches it. That is why a bundle's chapters are its files,
and why the length is always read from something the item states.

## Chapters

- Bundle → one chapter per volume, in the order archive.org lists the files. A volume that ships as
  both `.cbz` and `.pdf` is one row, and the zip wins because its pages can be listed.
- Scanned book → one chapter, `pageCount` from `imagecount`/`page_count`, else the page index, else
  an error naming the item. A guessed total shows a blank page mid-read, so it is never guessed.
- Chapter ids are `archive:ch:<identifier>:<book>`; a scanned book's chapter carries an empty book.

## Pages

- A `.cbz` volume's pages are its zip members, taken from the zip's own directory page in the order
  listed — that order is the reading order. A listing is cached for the session, so re-opening a
  chapter costs nothing.
- Only zip members can be listed. A `.cbr` or `.pdf` volume is still listed as a chapter, and opening
  it says `archive.org lists no pages inside …` rather than drawing an empty book.
- Pages carry no headers, so they load straight into `<img>` and through the image cache; no
  `/api/img` proxy hop is needed.

## Search

`advancedsearch.php`, scoped to `mediatype:texts` and the comic/magazine collections, 30 rows a page,
sorted by downloads (popular) or `-publicdate` (latest). A quote in the query is stripped so the
search box cannot become a query builder. Rows without an identifier are dropped: an untitled,
unopenable card is worse than one fewer row.

## Progress

`ownsProgress: true`. archive.org has no read-state API, so the local store owns these marks and the
provider's `setRead` rejects rather than pretending.
