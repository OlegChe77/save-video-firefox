<p align="center">
  <img src="docs/icon.png" width="96" height="96" alt="">
</p>

<h1 align="center">Save Video (Сохрани видео)</h1>

<p align="center">
  A Firefox extension that downloads YouTube videos up to 4K with sound —<br>
  right in the browser, no extra software needed.
</p>

<p align="center">
  <a href="README.md">Русский</a> · <b>English</b>
</p>

<p align="center">
  <a href="https://addons.mozilla.org/firefox/addon/ytdl-4k-clips-frames/"><b>Get it from Firefox Add-ons →</b></a>
</p>

<p align="center">
  <img src="docs/button.png" alt="Download button under the video with the quality menu">
</p>

> The extension interface is in Russian: «Скачать» = Download, «Отрывок» = Clip, «Кадр» = Frame, «Обложка» = Thumbnail.

## Features

- **Download button under every video.** Choose the quality — 4K, 2K, 1080p … 144p or audio only — and see the file size before you start.
- **Toolbar popup.** Thumbnail, title, quality picker and a downloads list with progress, speed and time left.
- **Clip.** Set a start and an end, and only that part is downloaded, accurate to the frame. Only the needed fragments are fetched, so it's fast even for hours-long videos.
- **Frame.** Saves the current frame as a full-resolution PNG.
- **Thumbnail.** Saves the video cover in maximum quality.
- **Fast.** Downloads in 6 parallel streams.
- **No quality loss.** Video and audio are merged into a regular MP4 without re-encoding: H.264 up to 1080p, AV1 or VP9 above that. Audio only is saved as M4A.
- **Nothing extra.** No programs to install, no data collected; the extension talks only to YouTube's servers.

Files are saved to `Downloads/YouTube`. The popup settings have an option to ask where to save each file.

## Screenshots

| Popup | Clip |
|---|---|
| ![Popup: thumbnail, quality picker and downloads list](docs/popup.png) | ![Clip: download only the part you need](docs/clip.png) |

## Installation

**From Firefox Add-ons** (recommended): [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/ytdl-4k-clips-frames/) → "Add to Firefox".

**From source** (for development):
1. Download this repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click "Load Temporary Add-on…" and select `extension/manifest.json`.

A temporary add-on stays loaded until Firefox restarts.

## How it works

Everything runs inside the extension — no server, no external tools.

1. **Stream URLs.** [`lib/youtube.js`](extension/lib/youtube.js) asks YouTube's internal API (`youtubei/v1/player`) for video data as the `VISIONOS` client — the same one yt-dlp uses. This client returns direct video and audio URLs that need no signature deciphering.
2. **Download.** [`background.js`](extension/background.js) fetches video and audio in parallel, in 8 MB ranges over 6 connections. For a clip it first reads the fragment index (`sidx`) and downloads only the fragments inside the requested interval.
3. **Merge.** [`lib/mp4.js`](extension/lib/mp4.js) is a small pure-JavaScript remuxer. It parses YouTube's fragmented MP4 streams and writes a regular MP4 with both tracks, without re-encoding. For clips, frames before the start point are hidden with an edit list (`edts`), so the clip starts exactly where you set it.
4. **Save.** The finished file is handed to the browser through the downloads API.

### Project structure

```
extension/
├── manifest.json
├── background.js        downloads, queue, saving files
├── content.js/.css      the button bar under the video
├── popup.html/.css/.js  the toolbar popup
├── common.js            shared helpers and icons
├── lib/
│   ├── youtube.js       video info and stream URLs
│   └── mp4.js           merging video and audio into MP4
└── icons/icon.svg
```

## Building

Requires Node.js.

```bash
npx web-ext lint -s extension
```

```bash
npx web-ext build -s extension -a dist
```

The package will appear in `dist/`.

## If downloads stop working

YouTube changes its internal API from time to time. The client parameters live at the top of [`lib/youtube.js`](extension/lib/youtube.js); usually it's enough to update them to match the current yt-dlp release. Please report problems in [Issues](../../issues).

## Disclaimer

This extension is meant for saving videos you have the rights to: your own uploads, videos under free licenses and so on. Respect copyright and YouTube's Terms of Service. This project is not affiliated with YouTube or Google.

The screenshots show frames from [Big Buck Bunny](https://peach.blender.org/) © Blender Foundation, licensed under CC BY 3.0.

## License

[MIT](LICENSE)
