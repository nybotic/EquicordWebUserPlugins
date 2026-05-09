# Equicord Web User Plugins

This workspace contains a modified Equicord Web Chrome extension with a custom user plugin manager.

## Load the extension

1. Open Chrome extensions: `chrome://extensions`.
2. Enable Developer mode.
3. Choose "Load unpacked".
4. Select `C:\Users\aaron\Documents\projects\EquicordProjects\EquicordWebUserPlugins\extension-chrome-src`.
5. Open Discord in the browser.

## Use custom plugins

Open the manager with the `UP` button in the bottom-right of Discord, or press `Ctrl+Shift+U`.

You can add plugins in either of these ways:

- Paste a GitHub repo URL, `owner/repo`, raw GitHub `.js` URL, or direct `.js` URL.
- Upload a local compiled `.js` or `.mjs` file.

For GitHub repositories, the loader checks for compiled JavaScript files in this order:

- `dist/index.js`
- `dist/plugin.js`
- `build/index.js`
- `bundle.js`
- `index.js`
- `plugin.js`
- `userplugin.js`

TypeScript-only repos need to be built first, or uploaded as compiled JavaScript.

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

