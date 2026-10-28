# kalengh — Architecture & Engineering Reference

Created and engineered by **exhuzaifa (Huzaifa Malik)** — [Portfolio](https://exhuzaifa.vercel.app) | [LinkedIn](https://www.linkedin.com/in/huzaifa-malikk/) | [Contra](https://contra.com/huzaifa_malik) | [GitHub](https://github.com/Techsynx/kalengh)

---

## 1. High-Level Architecture
**kalengh** is a desktop application built on **Electron**.
* **Main Process (`src/index.js`, `src/utils/gemini.js`, `src/storage.js`)**: Handles OS-level integrations, API request orchestration, multi-key rotation, global shortcuts, and encrypted local storage.
* **Renderer Process (`src/index.html`, `src/utils/renderer.js`, `src/components/`)**: Runs the glassmorphic HUD, handles WebRTC media capture (screen/audio), Lit web components, and Voice Activity Detection (VAD).

## 2. Audio Capture Pipeline
kalengh captures audio to transcribe conversation and technical interview questions with sub-second latency:
* **Windows**: Uses loopback system audio capture to isolate speaker output from microphone input, guaranteeing privacy.
* **macOS**: Spawns a native helper `SystemAudioDump` to capture system audio cleanly across macOS CoreAudio boundaries.
* **Linux**: Captures system audio via `getDisplayMedia` / ALSA / PulseAudio.
* **VAD (Voice Activity Detection)**: `renderer.js` processes raw PCM data in real-time chunks, calculates RMS, and identifies speech segments. Once silence is detected (default ~1.5–2s pause), the audio buffer is dispatched to Groq's `whisper-large-v3-turbo` endpoint.

## 3. Visual Capture (Multimodal)
* **Native Desktop Capture**: The app uses Electron's `desktopCapturer` in the Main Process (`ipcMain.handle('capture-native-screenshot')`) rather than `getDisplayMedia` in the Renderer to avoid browser-level telemetry/UI indicators (like the "Screen sharing" bar).
* **Accumulation Buffer**: When the user triggers manual screenshots (e.g. scrolling through a coding problem), frames are buffered in `renderer.js` (`screenshotAccumBuffer`). Pressing `Ctrl+Shift+K` stitches all frames into a single multimodal prompt.
* **Vision Models**: Groq's fast vision models (`llama-4-scout` or `llama-4-maverick`) are prioritized for lowest Time-To-First-Token, falling back to Gemini Vision.

## 4. LLM Routing & API Key Management
* **Groq as Primary**: Text-based Q&A uses Groq (`openai/gpt-oss-120b` or `llama-3.3-70b-versatile`) for blazing fast sub-second inference.
* **Key Rotation**: To bypass free-tier rate limits, `storage.js` supports rotating arrays of API keys. `gemini.js` dynamically catches 429/401 errors and rotates (`currentGroqKeyIndex`, `currentKeyIndex`) to the next available key seamlessly.
* **Gemini Fallback**: If all Groq keys/models fail, it falls back to Gemini (`gemini-2.5-flash-lite`).
* **Local Mode**: Supports 100% offline local inference via Ollama (`llama3.1`) and local Whisper.

## 5. Storage (`src/storage.js`)
* Stores config, credentials, preferences, keybinds, and history locally as `.json` files in the OS-specific directory (`kalengh-config`).
* Features automated backward-compatible migration from legacy configurations.
