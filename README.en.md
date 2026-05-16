# Time Wallpaper

Turn old local photos into a daily memory ritual on your Windows desktop.

Time Wallpaper selects ten meaningful "on this day" photos from your local library, writes restrained and poetic captions for them, and rotates them as desktop wallpapers. It is built for people with years of photos they rarely revisit: the app handles selection, layout, captioning, and wallpaper rendering while keeping the photo library local by default.

Chinese version: [README.md](README.md)

## Highlights

- **A small daily set**: exactly ten photos, so memory review stays lightweight.
- **Grounded captions**: avoids invented relationships, locations, events, and sentimental overreach.
- **Wallpaper-first rendering**: adapts to real monitor resolution and places text in a safer desktop area.
- **Flexible LLM providers**: supports OpenAI-compatible and Anthropic-compatible APIs.

## Features

- Pick one or more local photo folders and recursively scan `jpg/jpeg/png/webp/bmp/gif` images.
- Prefer photos that are close to "on this day", high resolution, sharp, and suitable for wallpaper use.
- If exact-date photos are too low-resolution, the app expands the date window to find better 4K-friendly candidates.
- Supports OpenAI-compatible and Anthropic-compatible APIs, including Bailian-compatible endpoints, MiMo-compatible endpoints, OpenRouter, One API, and other gateways.
- Uses stable prompt management and output validation to reduce hallucinated facts, overly sentimental wording, privacy risks, and repetitive sentence patterns.
- The "Memory Letter" view shows exactly ten selected photos, each with an AI-generated caption.
- Supports desktop wallpaper cycling: one photo per hour, ten photos in total.
- When setting a wallpaper, the app renders the caption and date into the final image, placed in the lower-right safe area by default.
- Adapts to the primary monitor's real physical resolution, including 1080p, 2K, 4K, multi-monitor setups, and mixed portrait/landscape photos.

## Usage

### Development

```powershell
npm install
npm run dev
```

### Build for Windows

```powershell
npm run dist
```

Build artifacts are written to the `release/` directory, including installer and zip packages.

## LLM Configuration

Open `LLM Settings` inside the app:

- Protocol:
  - `OpenAI-compatible`: for OpenAI, Bailian-compatible mode, MiMo OpenAI-compatible endpoints, OpenRouter, One API, and similar services.
  - `Anthropic-compatible`: for Anthropic Messages-compatible endpoints.
- Base URL: the provider's compatible API endpoint.
- API Key: the provider's API key.
- Model ID: the exact model name supported by the provider.
- Vision mode:
  - A vision-capable model is recommended so captions and scores can match the actual image content.

## Caption Pipeline

```text
Image -> Local EXIF/quality analysis -> Structured image input -> LLM captions and scores -> Program validation -> Cache -> UI/wallpaper rendering
```

Caption generation is designed to:

- Stay grounded in the image and structured metadata.
- Avoid unconfirmed relationships, locations, events, and emotional states.
- Avoid risky or over-assumptive words such as family, lover, friend, travel, happiness, regret, farewell, and forever.
- Generate multiple candidates per photo, while the UI and wallpaper use the first primary caption by default.
- Keep the ten captions distinct from one another.

## Privacy

Photos remain local by default. The app only sends images or structured metadata to an LLM provider after the user configures and enables it. Please review your provider's privacy policy before enabling vision mode.

## Release

Recommended release flow:

1. Update the version.
2. Run `npm run dist`.
3. Upload the Windows installer and zip package from `release/` to a GitHub Release.

If GitHub CLI is already authenticated with `gh auth login`, you can also run:

```powershell
npm run release:github
```

This command builds Windows packages, commits current changes, pushes `main` and the version tag, and creates or updates the GitHub Release.
