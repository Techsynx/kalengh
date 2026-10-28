# kalengh — Developer Guidelines & Standards

Created and maintained by **exhuzaifa (Huzaifa Malik)**.
* **Portfolio**: [exhuzaifa.vercel.app](https://exhuzaifa.vercel.app)
* **LinkedIn**: [linkedin.com/in/huzaifa-malikk/](https://www.linkedin.com/in/huzaifa-malikk/)
* **Contra**: [contra.com/huzaifa_malik](https://contra.com/huzaifa_malik)
* **GitHub**: [github.com/Techsynx/kalengh](https://github.com/Techsynx/kalengh)

## Getting Started

```bash
1. npm install
2. npm start
```

To build distributable installers:
```bash
npm run make
```

## Architecture & Code Standards

- **Low Latency First**: Audio -> VAD -> Whisper -> LLM response must complete within sub-second thresholds.
- **Privacy by Design**: Screen and audio capture happen entirely on the user's machine. Credentials stay local in `kalengh-config`.
- **Discreet HUD**: Glassmorphic transparent overlay with click-through mode (`Ctrl+M` / `Cmd+M`) and instant visibility toggle (`Ctrl+\` / `Cmd+\`).
- **Secure IPC**: Validate and sanitize all parameters crossing the Electron main/renderer process boundary.
