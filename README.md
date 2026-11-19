# suno-downloader

Download a Suno song as an MP3 from a link:

```bash
suno-downloader <suno song link>
```

No account or cookie is needed, including for private (unlisted) songs.

## How it works

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

## Install

```bash
cargo install --path .
```

Requires **ffmpeg** on `PATH` (`apt install ffmpeg`, `brew install ffmpeg`, …).

## Usage

```bash
suno-downloader <link> [options]
```

`<link>` can be a `suno.com/song/<id>` URL, a share link (redirects are
followed), or a bare song ID.

| Option | Description |
| --- | --- |
| `-o, --output <path>` | Output file, or a directory to keep the default name |
| `--bitrate <kbps>` | MP3 bitrate, e.g. `192` or `320` (default: VBR ~245 kbps) |
| `--no-tags` | Skip ID3 tags and cover art |
| `--force` | Overwrite an existing file |
| `-h, --help` / `-V, --version` | Help / version |

Without `-o`, the file is saved in the current directory as
`<artist> - <title>.mp3`. Original files are MP3-copied when the source is
already MP3; the encrypted Opus stream is re-encoded.

## Limitations

- Only completed songs can be fetched; songs still generating return an error.
- The audio source is Opus at ~132 kbps, so the MP3 cannot exceed that quality;
  the default VBR setting avoids adding further loss.
- Suno can rotate the rights endpoint or the wrapping scheme at any time. If
  downloads start failing, those two steps are what changed.
- Requests are unauthenticated, so heavy use may hit Suno's rate limits.
