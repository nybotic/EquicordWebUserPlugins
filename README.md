# Equicord Web User Plugins

This workspace contains a modified Equicord Web Chrome extension with a custom user plugin manager.

## Load the extension

1. Open Chrome extensions: `chrome://extensions`.
2. Enable Developer mode.
3. Choose "Load unpacked".
4. Select `C:\Users\aaron\Documents\projects\EquicordProjects\EquicordWebUserPlugins`.
5. Open Discord in the browser.

## Use custom plugins

Open Equicord settings, then go to the Plugins tab. The Custom User Plugins panel is shown there.

You can add plugins in either of these ways:

- Paste a GitHub repo URL, `owner/repo`, raw GitHub `.js` URL, or direct `.js` URL.
- Upload a local compiled `.js` / `.mjs` file, or upload a whole built plugin folder.

For GitHub repositories, the loader checks for compiled JavaScript files in this order:

- `dist/index.js`
- `dist/plugin.js`
- `build/index.js`
- `bundle.js`
- `index.js`
- `plugin.js`
- `userplugin.js`

TypeScript-only repos need to be built first, or uploaded as compiled JavaScript.

Folder uploads are scanned for compiled JavaScript candidates like `dist/index.js`, `index.js`, `plugin.js`, and `userplugin.js`. If you select a folder containing multiple top-level plugin folders, each folder is scanned and installed separately when it contains a usable JavaScript plugin file.

## Plugin shape

The safest format is:

```js
EquicordUserPlugins.register({
    name: "Example",
    start({ api }) {
        api.toast("Example plugin started", "SUCCESS");
    },
    stop() {
        console.log("Example plugin stopped");
    }
});
```

The loader also supports CommonJS-style exports:

```js
module.exports = {
    name: "Example",
    start() {},
    stop() {}
};
```
