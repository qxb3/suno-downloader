//! suno-downloader — turn a Suno song link into an MP3.
//!
//! How the reference downloader (usesuno.com/tools/downloader) does it, and
//! what this reproduces:
//!
//! 1. Clip metadata comes from `studio-api.prod.suno.com/api/clip/<id>`
//!    (public, no login). For anonymous clients its `audio_url` is
//!    `/api/forbidden`.
//! 2. The playable audio is served as an encrypted progressive stream at
//!    `d2lwuy8qc234o3.cloudfront.net/1/clip/<id>.m4a` (Opus in MP4).
//! 3. `POST studio-api.prod.suno.com/api/mango/rights` with
//!    `{content_params:{content_id:<id>,content_type:"clip"}}` returns `key`,
//!    `iv` and `glt` — no login needed.
//! 4. SHA-256 of `glt` is an AES-GCM key. `key` and `iv` are AES-GCM wrapped
//!    with that key, a 12-byte nonce prefix and the clip id as AAD. Unwrapping
//!    yields a 16-byte AES key and a 16-byte IV.
//! 5. The stream is AES-CTR (128-bit big-endian counter) encrypted with those.
//! 6. The decrypted M4A is transcoded to MP3 with ffmpeg.
//!
//! Some songs also expose a plain MP4 or a signed audio URL; those are used
//! directly when present.

use aes::cipher::{KeyIvInit, StreamCipher};
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const API_BASE: &str = "https://studio-api.prod.suno.com/api/clip/";
const RIGHTS_URL: &str = "https://studio-api.prod.suno.com/api/mango/rights";
const ENCRYPTED_AUDIO_BASE: &str = "https://d2lwuy8qc234o3.cloudfront.net/1/clip/";
const CDN_BASE: &str = "https://cdn1.suno.ai/";
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AES_BLOCK: usize = 16;

const HELP: &str = "\
suno-downloader — download a Suno song as MP3

USAGE:
    suno-downloader <link> [options]

ARGS:
    <link>    A suno.com song link, share link, or bare song id

OPTIONS:
    -o, --output <path>   Write here (a directory keeps the default file name)
        --bitrate <kbps>  MP3 bitrate, e.g. 192 or 320 [default: VBR ~245]
        --no-tags         Do not write ID3 tags or cover art
        --force           Overwrite an existing file
    -h, --help            Print this help
    -V, --version         Print the version

EXAMPLES:
    suno-downloader https://suno.com/song/67ea102d-52e0-41f1-96bf-746a9d15f498
    suno-downloader https://suno.com/s/abc123 -o ~/Music

Requires ffmpeg on PATH for MP3 encoding.
";

#[derive(Debug, Default, Deserialize)]
struct Clip {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    audio_url: Option<String>,
    #[serde(default)]
    video_url: Option<String>,
    #[serde(default)]
    image_url: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    handle: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    metadata: Metadata,
    #[serde(default)]
    media_urls: Vec<MediaUrl>,
}

#[derive(Debug, Default, Deserialize)]
struct Metadata {
    #[serde(default)]
    tags: Option<serde_json::Value>,
    #[serde(default)]
    duration: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct MediaUrl {
    url: String,
    #[serde(default)]
    content_type: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Rights {
    #[serde(default)]
    key: String,
    #[serde(default)]
    iv: String,
    #[serde(default)]
    glt: String,
}

#[derive(Debug)]
struct Args {
    link: String,
    output: Option<PathBuf>,
    bitrate: Option<u32>,
    tags: bool,
    force: bool,
}

enum Source {
    /// Straight download; `copy` means it is already MP3.
    Direct { url: String, copy: bool },
    /// Suno's encrypted progressive stream plus its unwrapped content key/IV.
    Encrypted { url: String, key: Vec<u8>, iv: Vec<u8> },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .context("could not create HTTP client")?;

    let id = resolve_song_id(&client, &args.link)?;
    let clip = fetch_clip(&client, &id)?;

    let title = clip
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    let artist = clip
        .display_name
        .clone()
        .or_else(|| clip.handle.clone())
        .filter(|artist| !artist.trim().is_empty())
        .unwrap_or_else(|| "Suno".to_string());

    if let Some(status) = clip.status.as_deref() {
        if status != "complete" {
            eprintln!("note: song status is \"{status}\"; the audio may be incomplete");
        }
    }

    println!("♪ {title} — {artist}");

    let source = resolve_source(&client, &clip, &id)?;
    let source_url = match &source {
        Source::Direct { url, .. } => url,
        Source::Encrypted { url, .. } => url,
    };
    let size_hint = probe(&client, source_url)?;

    let out_path = output_path(&args, &artist, &title);
    if out_path.exists() && !args.force {
        bail!(
            "{} already exists (use --force to overwrite)",
            out_path.display()
        );
    }

    ffmpeg_available()?;

    let tmp = TempDir::new(&id);
    let input = match source {
        Source::Direct { url, copy } => {
            let path = tmp.path.join(if copy { "source.mp3" } else { "source.media" });
            download(&client, &url, &path, size_hint)?;
            (path, copy)
        }
        Source::Encrypted { url, key, iv } => {
            let encrypted = tmp.path.join("encrypted.m4a");
            download(&client, &url, &encrypted, size_hint)?;
            let clear = tmp.path.join("decrypted.m4a");
            println!("Decrypting…");
            decrypt_stream(&encrypted, &clear, &key, &iv)
                .context("could not decrypt Suno's audio stream")?;
            (clear, false)
        }
    };

    let cover = if args.tags {
        match clip.image_url.as_deref() {
            Some(url) if url.starts_with("http") => match fetch_cover(&client, url, &tmp.path) {
                Ok(path) => Some(path),
                Err(err) => {
                    eprintln!("note: cover art skipped ({err})");
                    None
                }
            },
            _ => None,
        }
    } else {
        None
    };

    let tags = if args.tags {
        vec![
            ("title".to_string(), title.clone()),
            ("artist".to_string(), artist.clone()),
            ("album".to_string(), title.clone()),
            ("genre".to_string(), tags_string(&clip.metadata.tags)),
            ("date".to_string(), year_of(&clip.created_at)),
            (
                "comment".to_string(),
                format!("https://suno.com/song/{id}"),
            ),
        ]
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    println!("Encoding MP3…");
    encode_mp3(&input.0, cover.as_deref(), &out_path, args.bitrate, &tags, input.1)?;

    let bytes = fs::metadata(&out_path)
        .with_context(|| format!("could not read {}", out_path.display()))?
        .len();
    println!(
        "Saved {} ({:.1} MB{})",
        out_path.display(),
        bytes as f64 / 1_000_000.0,
        clip.metadata
            .duration
            .map(|duration| format!(" · {}", clock(duration)))
            .unwrap_or_default()
    );

    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut link = None;
    let mut output = None;
    let mut bitrate = None;
    let mut tags = true;
    let mut force = false;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("suno-downloader {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "-o" | "--output" => {
                let value = it.next().context("--output needs a path")?;
                output = Some(PathBuf::from(value));
            }
            "--bitrate" => {
                let value = it.next().context("--bitrate needs a value in kbps")?;
                let kbps: u32 = value
                    .trim_end_matches('k')
                    .parse()
                    .context("--bitrate must be a number in kbps, e.g. 192")?;
                if !(8..=320).contains(&kbps) {
                    bail!("--bitrate must be between 8 and 320 kbps");
                }
                bitrate = Some(kbps);
            }
            "--no-tags" => tags = false,
            "--force" => force = true,
            other if other.starts_with('-') && other != "-" => {
                bail!("unknown option {other} (try --help)")
            }
            other => {
                if link.is_some() {
                    bail!("expected one link, got more than one");
                }
                link = Some(other.to_string());
            }
        }
    }

    Ok(Args {
        link: link.context("missing <link> (try --help)")?,
        output,
        bitrate,
        tags,
        force,
    })
}

/// Find a Suno song UUID anywhere in the input (URL, share link, or bare id).
fn find_uuid(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    if bytes.len() < 36 {
        return None;
    }
    for start in 0..=bytes.len() - 36 {
        let window = &bytes[start..start + 36];
        let is_uuid = window.iter().enumerate().all(|(i, byte)| match i {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
        if is_uuid {
            return Some(text[start..start + 36].to_ascii_lowercase());
        }
    }
    None
}

/// Resolve share/short links by following redirects to the canonical song URL.
fn resolve_song_id(client: &reqwest::blocking::Client, input: &str) -> Result<String> {
    let input = input.trim();
    if let Some(id) = find_uuid(input) {
        return Ok(id);
    }

    let url = if input.starts_with("http://") || input.starts_with("https://") {
        input.to_string()
    } else {
        format!("https://suno.com/s/{}", input.trim_start_matches('/'))
    };

    let response = client
        .get(&url)
        .timeout(Duration::from_secs(30))
        .send()
        .with_context(|| format!("could not open {url}"))?;
    let status = response.status();
    let final_url = response.url().clone();
    drop(response);

    if let Some(id) = find_uuid(final_url.as_str()) {
        return Ok(id);
    }
    bail!("no Suno song id found in {url} (HTTP {status})");
}

fn fetch_clip(client: &reqwest::blocking::Client, id: &str) -> Result<Clip> {
    let url = format!("{API_BASE}{id}");
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(30))
        .send()
        .with_context(|| format!("could not reach {url}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("song {id} was not found (it may be private or deleted)");
    }
    if !response.status().is_success() {
        bail!("Suno API returned HTTP {} for song {id}", response.status());
    }

    let clip: Clip = response
        .json()
        .with_context(|| format!("unexpected response from {url}"))?;
    if clip.id.is_empty() && clip.title.is_none() {
        bail!("Suno returned no song data for {id}");
    }
    Ok(clip)
}

/// Fetch the wrapped AES key, IV and guest token Suno's player uses.
fn fetch_rights(client: &reqwest::blocking::Client, id: &str) -> Result<Rights> {
    let body = serde_json::json!({
        "content_params": { "content_id": id, "content_type": "clip" }
    });
    let response = client
        .post(RIGHTS_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ORIGIN, "https://suno.com")
        .header(reqwest::header::REFERER, "https://suno.com/")
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .with_context(|| "could not reach Suno's rights endpoint")?;

    if !response.status().is_success() {
        bail!(
            "Suno's rights endpoint returned HTTP {} for song {id}",
            response.status()
        );
    }
    let rights: Rights = response
        .json()
        .context("unexpected response from Suno's rights endpoint")?;
    if rights.key.is_empty() || rights.iv.is_empty() || rights.glt.is_empty() {
        bail!("Suno's rights response is missing key, IV, or guest token data");
    }
    Ok(rights)
}

fn decode_base64(value: &str) -> Result<Vec<u8>> {
    let normalized = value
        .trim()
        .chars()
        .map(|ch| match ch {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect::<String>();
    let padding = (4 - normalized.len() % 4) % 4;
    let padded = format!("{normalized}{}", "=".repeat(padding));
    BASE64
        .decode(padded)
        .context("Suno's rights response contained invalid base64")
}

/// AES-GCM unwrap: 12-byte nonce prefix, ciphertext+tag, clip id as AAD.
fn unwrap_secret(cipher: &Aes256Gcm, wrapped: &str, id: &str, label: &str) -> Result<Vec<u8>> {
    let bytes = decode_base64(wrapped)?;
    if bytes.len() < 12 + 16 {
        bail!("Suno's wrapped audio {label} is incomplete");
    }
    let (nonce, ciphertext) = bytes.split_at(12);
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("could not unwrap the audio {label}"))?;
    Ok(plain)
}

fn usable_audio_url(url: &str) -> bool {
    url.starts_with("http") && !url.contains("/api/forbidden")
}

fn is_plain_media(media: &MediaUrl) -> bool {
    let content_type = media
        .content_type
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    !content_type.contains("opus")
        && (content_type.contains("mpeg")
            || content_type.contains("mp3")
            || content_type == "audio/mp4"
            || content_type == "audio/m4a"
            || media.url.to_ascii_lowercase().contains(".mp3"))
}

fn looks_like_mp3(url: &str) -> bool {
    url.split('?')
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase()
        .ends_with(".mp3")
}

/// Prefer direct audio, then the encrypted stream (its keys are public), then
/// the song's public MP4 as a last resort.
fn resolve_source(
    client: &reqwest::blocking::Client,
    clip: &Clip,
    id: &str,
) -> Result<Source> {
    if let Some(url) = clip.audio_url.as_deref().filter(|url| usable_audio_url(url)) {
        return Ok(Source::Direct {
            url: url.to_string(),
            copy: looks_like_mp3(url),
        });
    }

    if let Some(media) = clip.media_urls.iter().find(|media| is_plain_media(media)) {
        return Ok(Source::Direct {
            url: media.url.clone(),
            copy: looks_like_mp3(&media.url),
        });
    }

    let encrypted_error = match encrypted_source(client, id) {
        Ok(source) => return Ok(source),
        Err(err) => err,
    };

    let video = clip
        .video_url
        .as_deref()
        .filter(|url| url.starts_with("http"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{CDN_BASE}{id}.mp4"));
    if probe(client, &video)?.is_some() {
        return Ok(Source::Direct {
            url: video,
            copy: false,
        });
    }

    Err(encrypted_error.context(format!(
        "no downloadable audio found for song {id}"
    )))
}

fn encrypted_source(client: &reqwest::blocking::Client, id: &str) -> Result<Source> {
    let url = format!("{ENCRYPTED_AUDIO_BASE}{id}.m4a");
    if probe(client, &url)?.is_none() {
        bail!("the encrypted audio stream is not available");
    }

    let rights = fetch_rights(client, id)?;
    let user_key = Sha256::digest(rights.glt.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&user_key)
        .map_err(|_| anyhow::anyhow!("could not derive the audio key"))?;

    let key = unwrap_secret(&cipher, &rights.key, id, "key")?;
    let iv = unwrap_secret(&cipher, &rights.iv, id, "IV")?;
    if iv.len() != AES_BLOCK {
        bail!("the unwrapped audio IV must be 16 bytes");
    }
    if key.len() != 16 && key.len() != 32 {
        bail!("unsupported audio key length {}", key.len());
    }

    Ok(Source::Encrypted { url, key, iv })
}

fn decrypt_stream(src: &Path, dest: &Path, key: &[u8], iv: &[u8]) -> Result<()> {
    match key.len() {
        16 => decrypt_stream_with::<ctr::Ctr128BE<aes::Aes128>>(src, dest, key, iv),
        32 => decrypt_stream_with::<ctr::Ctr128BE<aes::Aes256>>(src, dest, key, iv),
        other => bail!("unsupported audio key length {other}"),
    }
}

fn decrypt_stream_with<C>(src: &Path, dest: &Path, key: &[u8], iv: &[u8]) -> Result<()>
where
    C: KeyIvInit + StreamCipher,
{
    let mut cipher = C::new_from_slices(key, iv)
        .map_err(|_| anyhow::anyhow!("invalid audio key or IV"))?;
    let mut input = File::open(src).with_context(|| format!("could not open {}", src.display()))?;
    let mut output =
        File::create(dest).with_context(|| format!("could not create {}", dest.display()))?;
    let mut buffer = vec![0u8; 128 * 1024];

    loop {
        let read = input.read(&mut buffer).context("could not read audio")?;
        if read == 0 {
            break;
        }
        cipher.apply_keystream(&mut buffer[..read]);
        output
            .write_all(&buffer[..read])
            .context("could not write decrypted audio")?;
    }
    Ok(())
}

/// Check that a URL is downloadable and report its size when known.
fn probe(client: &reqwest::blocking::Client, url: &str) -> Result<Option<u64>> {
    let head = client
        .head(url)
        .timeout(Duration::from_secs(20))
        .send()
        .with_context(|| format!("could not reach {url}"))?;
    if head.status().is_success() {
        return Ok(Some(head.content_length().unwrap_or(0)));
    }

    // Some CDNs refuse HEAD; a one-byte ranged GET is a cheap fallback.
    let ranged = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .timeout(Duration::from_secs(20))
        .send()
        .with_context(|| format!("could not reach {url}"))?;
    let status = ranged.status();
    if status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT {
        return Ok(Some(0));
    }
    Ok(None)
}

fn download(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    size_hint: Option<u64>,
) -> Result<()> {
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .with_context(|| format!("could not download {url}"))?;
    if !response.status().is_success() {
        bail!("download failed with HTTP {} from {url}", response.status());
    }

    let total = response.content_length().or(size_hint);
    let interactive = io::stderr().is_terminal();
    let mut file =
        File::create(dest).with_context(|| format!("could not create {}", dest.display()))?;
    let mut buffer = vec![0u8; 128 * 1024];
    let mut written: u64 = 0;
    let mut last_paint = Instant::now();

    if interactive {
        eprint!("  Downloading 0%");
    } else {
        eprintln!("Downloading {url}");
    }

    loop {
        let read = response.read(&mut buffer).context("download interrupted")?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .context("could not write download")?;
        written += read as u64;
        if interactive && last_paint.elapsed() >= Duration::from_millis(150) {
            match total.filter(|&total| total > 0) {
                Some(total) => eprint!("\r  Downloading {:>3}%", written * 100 / total),
                None => eprint!("\r  Downloading {:.1} MB", written as f64 / 1e6),
            }
            last_paint = Instant::now();
        }
    }
    file.flush().ok();

    if written == 0 {
        bail!("download from {url} was empty");
    }
    if interactive {
        eprintln!("\r  Downloaded {:.1} MB   ", written as f64 / 1e6);
    }
    Ok(())
}

fn fetch_cover(client: &reqwest::blocking::Client, url: &str, dir: &Path) -> Result<PathBuf> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .with_context(|| format!("cover request failed for {url}"))?;
    if !response.status().is_success() {
        bail!("HTTP {} for cover art", response.status());
    }
    let bytes = response.bytes().context("could not read cover art")?;
    if bytes.is_empty() {
        bail!("cover art was empty");
    }
    let path = dir.join("cover.jpg");
    fs::write(&path, &bytes).context("could not save cover art")?;
    Ok(path)
}

fn ffmpeg_available() -> Result<()> {
    match Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => Ok(()),
        _ => bail!(
            "ffmpeg was not found on PATH; it is required to encode MP3.\n\
             Install it from https://ffmpeg.org/download.html (e.g. `apt install ffmpeg`, `brew install ffmpeg`)"
        ),
    }
}

fn encode_mp3(
    source: &Path,
    cover: Option<&Path>,
    out: &Path,
    bitrate: Option<u32>,
    tags: &[(String, String)],
    copy: bool,
) -> Result<()> {
    let mut command = Command::new("ffmpeg");
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source);

    if let Some(cover) = cover {
        command.arg("-i").arg(cover);
    }

    command.args(["-map", "0:a:0"]);
    // Drop the container's own metadata (major_brand, encoder, ...) so only
    // the tags below end up in the MP3.
    command.args(["-map_metadata", "-1"]);
    if cover.is_some() {
        command.args([
            "-map",
            "1:v:0",
            "-c:v",
            "mjpeg",
            "-disposition:v:0",
            "attached_pic",
        ]);
    }

    if copy {
        // Already MP3: keep the original bits.
        command.args(["-c:a", "copy"]);
    } else {
        command.arg("-c:a").arg("libmp3lame");
        match bitrate {
            Some(kbps) => {
                command.arg("-b:a").arg(format!("{kbps}k"));
            }
            None => {
                command.args(["-q:a", "0"]);
            }
        }
    }
    command.args(["-id3v2_version", "3"]);

    if let Some(dir) = out.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir)
                .with_context(|| format!("could not create {}", dir.display()))?;
        }
    }

    for (key, value) in tags {
        command.arg("-metadata").arg(format!("{key}={value}"));
    }
    if cover.is_some() {
        command
            .args(["-metadata:s:v", "title=Cover"])
            .args(["-metadata:s:v", "comment=Cover (front)"]);
    }

    command.arg(out);

    let output = command.output().context("could not run ffmpeg")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("ffmpeg failed:\n{}", stderr.trim());
    }
    Ok(())
}

fn output_path(args: &Args, artist: &str, title: &str) -> PathBuf {
    let default_name = format!(
        "{}.mp3",
        sanitize_file_name(&format!("{artist} - {title}"))
    );
    match &args.output {
        Some(path) if path.is_dir() || path.to_string_lossy().ends_with('/') => {
            path.join(default_name)
        }
        Some(path) => path.clone(),
        None => PathBuf::from(default_name),
    }
}

fn sanitize_file_name(name: &str) -> String {
    let mut cleaned = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => cleaned.push('_'),
            ch if ch.is_control() => cleaned.push(' '),
            ch => cleaned.push(ch),
        }
    }
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|ch: char| ch == '.' || ch == ' ');
    let result: String = trimmed.chars().take(150).collect();
    let result = result.trim_end();
    if result.is_empty() {
        "suno".to_string()
    } else {
        result.to_string()
    }
}

fn tags_string(tags: &Option<serde_json::Value>) -> String {
    match tags {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

fn year_of(created_at: &Option<String>) -> String {
    created_at
        .as_deref()
        .filter(|value| value.len() >= 4 && value[..4].chars().all(|ch| ch.is_ascii_digit()))
        .map(|value| value[..4].to_string())
        .unwrap_or_default()
}

fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// Temporary working directory that cleans itself up, including on errors.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(id: &str) -> Self {
        let short = &id[..id.len().min(8)];
        let path = std::env::temp_dir().join(format!(
            "suno-downloader-{}-{short}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        let _ = fs::create_dir_all(&path);
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_uuid_in_links() {
        let id = "67ea102d-52e0-41f1-96bf-746a9d15f498";
        assert_eq!(
            find_uuid(&format!("https://suno.com/song/{id}?sh=abc")).as_deref(),
            Some(id)
        );
        assert_eq!(
            find_uuid(&format!("https://suno.com/embed/{id}")).as_deref(),
            Some(id)
        );
        assert_eq!(find_uuid(id).as_deref(), Some(id));
        assert_eq!(find_uuid("https://suno.com/s/abc123"), None);
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize_file_name("a/b:c*?\"<>|"), "a_b_c______");
        assert_eq!(sanitize_file_name("  spaced   out  "), "spaced out");
        assert_eq!(sanitize_file_name("..."), "suno");
    }

    #[test]
    fn ignores_forbidden_and_encrypted_sources() {
        assert!(!usable_audio_url(
            "https://studio-api.prod.suno.com/api/forbidden"
        ));
        assert!(usable_audio_url("https://cdn1.suno.ai/x.mp3?sig=1"));
        assert!(!looks_like_mp3("https://cdn1.suno.ai/x.m4a"));
        assert!(looks_like_mp3("https://cdn1.suno.ai/x.mp3?sig=1"));
    }

    #[test]
    fn matches_usesuno_wrapping_scheme() {
        // Build the same envelope the site receives: AES-GCM under
        // SHA-256(glt), 12-byte nonce, clip id as AAD, base64 payload.
        let id = "36609702-93ee-467d-b011-b6b6554ed492";
        let glt = "guest-token";
        let user_key = Sha256::digest(glt.as_bytes());
        let cipher = Aes256Gcm::new_from_slice(&user_key).unwrap();

        let content_key = [7u8; 16];
        let nonce = [3u8; 12];
        let wrapped = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &content_key,
                    aad: id.as_bytes(),
                },
            )
            .unwrap();
        let mut envelope = nonce.to_vec();
        envelope.extend_from_slice(&wrapped);
        let encoded = BASE64.encode(envelope);

        assert_eq!(
            unwrap_secret(&cipher, &encoded, id, "key").unwrap(),
            content_key
        );
        assert!(unwrap_secret(&cipher, &encoded, "other-id", "key").is_err());
    }

    #[test]
    fn decrypts_aes_ctr_stream() {
        use aes::cipher::{KeyIvInit, StreamCipher};
        let key = [9u8; 16];
        let iv = [5u8; 16];
        let plaintext = b"hello suno, this is a test of the counter stream".to_vec();
        let mut encrypted = plaintext.clone();
        let mut cipher = ctr::Ctr128BE::<aes::Aes128>::new_from_slices(&key, &iv).unwrap();
        cipher.apply_keystream(&mut encrypted);
        assert_ne!(encrypted, plaintext);

        let dir = std::env::temp_dir().join(format!("suno-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dest = dir.join("dest.bin");
        fs::write(&src, &encrypted).unwrap();
        decrypt_stream(&src, &dest, &key, &iv).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), plaintext);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn decodes_url_safe_and_padded_base64() {
        assert_eq!(decode_base64("aGk").unwrap(), b"hi");
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("aGk-").unwrap()[..2], b"hi"[..]);
    }

    #[test]
    fn formats_time() {
        assert_eq!(clock(349.28), "5:49");
        assert_eq!(clock(9.6), "0:10");
    }
}
