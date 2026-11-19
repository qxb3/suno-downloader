# Suno Downloader — Tampermonkey

A userscript port of the `suno-downloader` CLI. On [suno.com](https://suno.com)
it replaces the **share button** of a song with a **download button** that saves
the track as MP3.

Suno's markup has one trap: every control is an `hxc` design-system button, so
`<span aria-hidden="true" class="hxc-btn-tap-target">` is *not* unique — it is
the invisible tap area inside all of them. The script therefore anchors on the
share control itself:

```html
<button aria-label="Share" class="hxc-btn-base …">
  <span aria-hidden="true" class="hxc-btn-tap-target"></span>
```

The replacement copies that button's class list and rebuilds its inner spans
(`hxc-btn-tap-target`, `hxc-btn-overlay-slot`, `hxc-btn-content`) with a
download icon, so it keeps the exact size, shape and hover treatment of the
control it replaces. Share controls that do not belong to a song (page or
playlist headers) are left alone, as is every other button.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open the extension's dashboard → **Create a new script**, paste
   [`suno-downloader.user.js`](./suno-downloader.user.js) and save. Dragging the
   file onto a browser window also opens the install page.
3. Open a song or playlist on suno.com. The download button sits where the share
   button used to be.

The script pulls lamejs (the MP3 encoder) from jsDelivr via `@require`, and
`@connect`s to the studio API, the CloudFront stream and `cdn1.suno.ai`.
No account is needed; it works signed out.

## What it downloads

Clicking the button resolves the song id from the card it lives on (or the page
URL) and tries, in the CLI's order:

| Source | Result |
| --- | --- |
| Signed `audio_url` / plain media from the clip API | MP3 copied as-is; other audio re-encoded |
| Suno's encrypted Opus stream (rights → AES-GCM unwrap → AES-CTR) | Opus → PCM → **MP3, 256 kbps**, encoded in parallel |
| The song's rendered MP4 | `.mp4` |

`audio_url` is usually the literal `/api/forbidden` decoy for anonymous
requests, so the encrypted stream is the normal path. The MP3 is produced in the
browser: `AudioContext.decodeAudioData` turns the decrypted Opus into PCM, then
the PCM is cut into slices and each slice is encoded in its own Web Worker with
lamejs, and the results are concatenated (MP3 frames are self-contained).

On a 12-core box, a 5:49 track encodes in **4.5 s** across 8 workers versus
**73 s** single-threaded; a 4-core machine lands around 9–10 s. Progress is
shown in a toast and in the button tooltip.

Every MP3 is then tagged with an ID3v2.3 block — title, artist, album, genre,
year and the song URL — plus the clip's cover image as a front-cover `APIC`
frame, the same set the CLI's ffmpeg step writes. Text that is not ASCII is
written as UTF-16, which is what the v2.3 spec requires (it has no UTF-8).

## Differences from the CLI

- **`--bitrate` is a constant**, `MP3_BITRATE = 256` (the CLI's default is VBR
  ~245 kbps, so this is the nearest CBR equivalent). Edit the constant to change
  it.
- **Encoding is CPU-bound**: it uses one worker per core (capped at 8), so a
  slower machine or a low core count takes proportionally longer. If Workers are
  blocked by a CSP, it falls back to a single encoder on the main thread that
  yields between blocks — slower, but the page stays responsive and progress
  still updates.
- **WebGL is no help here**: MP3 encoding is serial bit-reservoir/Huffman work,
  not vectorizable arithmetic, so a GPU path would be slower, not faster.
- **Browsers without an Opus-in-MP4 decoder** (Firefox in practice) cannot make
  PCM from Suno's stream; the file is then saved as the original `.m4a` and the
  toast says so. Chrome/Chromium gets MP3.
- **No startup flags** — no `-o`, `--no-tags` or `--force`; the browser's
  download folder handles names and collisions. Files are saved as
  `<artist> - <title>.<ext>`.
- **Tags are always written**, without the CLI's `--no-tags` escape hatch. When
  the source is already an MP3, the new tag is prepended to it (readers use the
  first tag), and the 1 KiB of padding after the frames lets players rewrite it.

## If the button does not appear

The script matches the control's accessible name — `aria-label`, then `title`,
then its text — against `^share( (song|clip|track))?$`. If Suno renames it,
update `SHARE_LABEL` at the top of the script; the rest of the download
pipeline is independent of the markup.
