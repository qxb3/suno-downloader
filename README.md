# suno-downloader

Download a Suno song as an MP3 from a link:

```bash
suno-downloader <suno song link>
```

No account or cookie is needed, including for private (unlisted) songs.

There is a browser version too: the [Tampermonkey userscript](#browser-tampermonkey)
puts a download button straight on suno.com — same endpoints, no ffmpeg and no
terminal.

## Install

Prebuilt static binaries and native packages are attached to each
[release](https://github.com/qxb3/suno-downloader/releases). All of them need
**ffmpeg** on `PATH` (`apt install ffmpeg`, `dnf install ffmpeg-free`,
`pacman -S ffmpeg`, `brew install ffmpeg`, …); the packages declare it as a
dependency.

**Debian, Ubuntu, Mint, Pop!_OS, Kali, Raspberry Pi OS** — `amd64` or `arm64`:

```bash
sudo apt install ./suno-downloader_*.deb
```

**Fedora, RHEL, Rocky, Alma, CentOS Stream** — `x86_64` or `aarch64`:

```bash
sudo dnf install ./suno-downloader-*.rpm
```

On Fedora, ffmpeg comes from `ffmpeg-free` or RPM Fusion; RHEL needs RPM Fusion.
The package depends on `/usr/bin/ffmpeg`, so whichever build is installed
satisfies it.

**openSUSE** — `x86_64` or `aarch64`:

```bash
sudo zypper install ./suno-downloader-*.rpm
```

ffmpeg on openSUSE comes from [Packman](https://packman.links2linux.org/).

**Arch Linux, Arch Linux ARM, Manjaro, EndeavourOS, CachyOS** — download
`PKGBUILD` from the release, then:

```bash
makepkg -si
```

**Any other distribution** — the static tarball runs anywhere (musl,
static-pie, no glibc requirement):

```bash
# x86_64; use the aarch64 tarball for ARM64
tar -xzf suno-downloader-*-x86_64-unknown-linux-musl.tar.gz
sudo install suno-downloader-*/suno-downloader /usr/local/bin/
```

**From source**:

```bash
cargo install --path .
```

Verify downloads with `sha256sum --check <file>.sha256`.

## Browser (Tampermonkey)

Prefer not to install a CLI? [`tampermonkey/`](./tampermonkey) is a userscript
that replaces the share button on [suno.com](https://suno.com) with a download
button:

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open [`tampermonkey/suno-downloader.user.js`](./tampermonkey/suno-downloader.user.js)
   and let the extension install it, or paste it into a new script.
3. Open a song or playlist on suno.com and press the download button where the
   share button used to be.

It walks the same steps described above — clip metadata, the rights endpoint,
AES-GCM unwrap, AES-CTR decryption — but finishes in the browser: the Opus
stream is decoded with `AudioContext` and encoded to 256 kbps MP3 by lamejs,
split over one Web Worker per core (a 6-minute song takes seconds on a modern
machine), then tagged with ID3v2.3 (title, artist, album, genre, year, song URL)
and the cover art. Chrome or Chromium is recommended; browsers that cannot
decode Opus in MP4 (Firefox in practice) save the decrypted `.m4a` instead.

See [`tampermonkey/README.md`](./tampermonkey/README.md) for details,
differences from the CLI, and troubleshooting.

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
