# Background pictures

**To change the background, edit `web/src/background.ts`** — one constant at the
top of the file. This directory just holds the images.

## Preparing one

Downscale it. A photo straight off a stock site is commonly 1–5 MB, and this is
the first thing a phone on cellular has to fetch. 1100px wide is plenty at the
size it renders and lands around 140 KB:

```sh
sips --resampleWidth 1100 -s format jpeg -s formatOptions 82 ~/Downloads/yours.jpg \
     --out web/public/bg/yours.jpg
```

Use `--resampleWidth`, not `-Z`. `-Z` caps the *longest* side, so a portrait
picture comes out far narrower than intended and looks soft once
`background-size: cover` scales it up.

Keep quality at 82. Backgrounds tend to be smooth gradients, which is exactly
where JPEG banding shows, and dropping to 60 saves only about 30 KB.

Then point `BACKGROUND_IMAGE` at `/bg/yours.jpg` and re-judge
`BACKGROUND_STRENGTH` — the right opacity depends on the picture.

## Credit

The current picture, `opt1.jpg`, was supplied by the operator. If it came from
somewhere that requires attribution, record it here — this file is served
publicly, so it is a place a credit can legitimately live. Unsplash requires
none.
