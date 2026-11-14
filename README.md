# Terminal in Browser

Run a real local terminal directly inside a browser tab.

## Supported Operating Systems

- [x] Windows (10 / 11)
- [ ] macOS
- [ ] Linux

**Browsers:** Chromium-based browsers (Chrome, Brave, Edge, Vivaldi). Firefox is experimental.

## Features

- Full local terminal powered by `xterm.js` and `node-pty`
- Supports Windows PowerShell, PowerShell 7, and Command Prompt (right-click the toolbar icon to switch)
- Opens in the current folder when triggered from a `file:///` tab
- Keeps shells alive briefly on tab close and reconnects on reload
- Localhost-only WebSocket bridge with token authentication

## Setup

**Requirements:** Windows 10/11 and [Node.js](https://nodejs.org) 18+.

1. **Install dependencies:**
   ```powershell
   cd server
   npm install
   ```

2. **Load the extension:**
   - **Chrome / Brave / Edge / Vivaldi:** Open `chrome://extensions` (or equivalent), enable **Developer mode**, click **Load unpacked**, and select the `extension` folder.
   - **Firefox:** Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `extension/manifest.json`.

3. **Register the native host:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File host\install.ps1
   ```
   Reload the extension afterwards. Alternatively, double-click `Terminal Tray.bat` to run the bridge from the system tray without registering the native host.

## Usage

| Action | Result |
| --- | --- |
| Click toolbar icon or `Alt+Shift+P` | Open a new terminal tab |
| Right-click toolbar icon | Pick Windows PowerShell, PowerShell 7, or Command Prompt |
| `Ctrl+C` (with selection) / `Ctrl+V` | Copy / Paste |
| `Ctrl+Shift+F` | Search scrollback |