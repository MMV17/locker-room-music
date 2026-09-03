# Background photos — credits and how to swap one in

**To change the background, edit `web/src/background.ts`** — one constant at the
top of the file. This directory just holds the images.

## Cutting a replacement

macOS only, no dependencies. These files are already blurred, because blurring
in CSS instead makes the browser recompute a viewport-sized blur and stutter
while scrolling on an older phone.

`sips` has no blur, so the blur comes from throwing the detail away and
enlarging what is left — the resampler does the smoothing. The intermediate
width *is* the blur radius: smaller is blurrier, and 110 is what these were cut
at.

```sh
sips -Z 110 whatever-you-downloaded.jpg --out /tmp/_t.jpg
sips -Z 1000 -s format jpeg -s formatOptions 42 /tmp/_t.jpg --out web/public/bg/mine.jpg
```

Expect 30–50 KB. Much larger means the blur pass did not happen — check the
intermediate file, not the quality setting. Then point `BACKGROUND_IMAGE` at
`/bg/mine.jpg`.

## Credits

These four are placeholders. They are Creative Commons off Wikimedia Commons,
which means using one on a public site requires the credit below to stay
reachable. **Unsplash needs no attribution and no share-alike** — if you replace
these with an Unsplash photo, this whole section can go.

| file | photographer | licence | source |
|------|--------------|---------|--------|
| gym.jpg | Linda Banks | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | [1958 Redfield, Arkansas Gymnasium Interior](https://commons.wikimedia.org/wiki/File:1958_Redfield,_Arkansas_Gymnasium_Interior.jpg) |
| arena.jpg | Wiiii | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) | [Tokyo Metropolitan Gymnasium Interior](https://commons.wikimedia.org/wiki/File:Tokyo_Metropolitan_Gymnasium_Interior.jpg) |
| court.jpg | &DC, Coulsdon, Greater London | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) | [London 2012 Olympic Basketball Arena](https://commons.wikimedia.org/wiki/File:London_2012_Olympic_Basketball_Arena.jpg) |
| game.jpg | Danny Karwoski | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) | [McDonough Gymnasium interior](https://commons.wikimedia.org/wiki/File:McDonough_Gymnasium_interior.jpg) |

All four are downscaled and blurred from the originals.
