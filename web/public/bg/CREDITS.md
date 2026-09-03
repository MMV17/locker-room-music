# Background candidates — sources and licences

These four are **placeholders for judging the treatment**, not a final choice.
Every one is Creative Commons off Wikimedia Commons, which means using it on a
public site legally requires the credit below to appear somewhere a visitor can
reach. Nothing in the app renders this file yet.

If a background is going to ship, **replace these with Unsplash**. The Unsplash
licence needs no attribution and no share-alike, which removes both the credit
obligation and the question of whether a blurred derivative of a BY-SA photo
has to be BY-SA as well. Search from a normal browser — Unsplash blocks
automated search, so this had to be sourced elsewhere.

| id | file | photographer | licence | source |
|----|------|--------------|---------|--------|
| `gym` | gym.jpg | Linda Banks | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | [1958 Redfield, Arkansas Gymnasium Interior](https://commons.wikimedia.org/wiki/File:1958_Redfield,_Arkansas_Gymnasium_Interior.jpg) |
| `arena` | arena.jpg | Wiiii | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) | [Tokyo Metropolitan Gymnasium Interior](https://commons.wikimedia.org/wiki/File:Tokyo_Metropolitan_Gymnasium_Interior.jpg) |
| `court` | court.jpg | &DC, Coulsdon, Greater London | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) | [London 2012 Olympic Basketball Arena](https://commons.wikimedia.org/wiki/File:London_2012_Olympic_Basketball_Arena.jpg) |
| `game` | game.jpg | Danny Karwoski | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) | [McDonough Gymnasium interior](https://commons.wikimedia.org/wiki/File:McDonough_Gymnasium_interior.jpg) |

All four are cropped, downscaled and blurred from the originals.

## Cutting a replacement

macOS only, no dependencies. `sips` has no blur, so the blur is produced by
throwing the detail away and enlarging what is left — the resampler does the
smoothing. Two passes, and the intermediate width *is* the blur radius: smaller
is blurrier, and 110 is the value the four above were cut at.

```sh
sips -Z 110 original.jpg --out /tmp/_t.jpg
sips -Z 1000 -s format jpeg -s formatOptions 42 /tmp/_t.jpg --out web/public/bg/<id>.jpg
```

Expect roughly 30–50 KB. A file materially larger than that means the blur pass
did not happen — check the intermediate, not the quality setting.

Then add `{ id: "<id>", label: "..." }` to `CANDIDATES` in
`web/src/background.ts`. Nothing else refers to these names.
