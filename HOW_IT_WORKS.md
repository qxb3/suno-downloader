# How it works

This reproduces the flow used by the downloader at
[usesuno.com/tools/downloader](https://usesuno.com/tools/downloader) without
going through that site:

1. **Metadata** — `GET https://studio-api.prod.suno.com/api/clip/<id>` is
   public and returns the title, artist, tags, duration, cover and lyrics
   prompt. Its `audio_url` reads `/api/forbidden` for anonymous clients.
2. **Encrypted stream** — the playable audio is a progressive stream at
   `https://d2lwuy8qc234o3.cloudfront.net/1/clip/<id>.m4a` (Opus in MP4,
   ~132 kbps). It is AES-CTR encrypted.
3. **Keys** — `POST https://studio-api.prod.suno.com/api/mango/rights` with
   `{"content_params":{"content_id":"<id>","content_type":"clip"}}` returns
   `key`, `iv` and `glt`. This is the same guest-token endpoint Suno's web
   player uses, so it works signed out.
4. **Unwrap** — `SHA-256(glt)` is an AES-256-GCM key. `key` and `iv` are
   base64 AES-GCM envelopes: a 12-byte nonce prefix, then ciphertext + tag,
   with the clip UUID as additional authenticated data. Unwrapping gives the
   16-byte content key and 16-byte IV.
5. **Decrypt** — the stream is AES-CTR with a 128-bit big-endian counter
   initialised to the IV. The result is a valid M4A.
6. **Transcode** — ffmpeg decodes the Opus track, encodes MP3 and writes ID3
   tags (title, artist, album, genre, year, song URL) plus the cover art.

Songs that expose a signed `audio_url` or a plain media entry are downloaded
directly, and songs with a rendered public MP4 fall back to extracting that
video's AAC track if the encrypted stream is unavailable.
