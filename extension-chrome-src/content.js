if (typeof browser === "undefined") {
    var browser = chrome;
}

function getExtensionBasePath() {
    const manifest = browser.runtime.getManifest();
    const scripts = manifest.content_scripts?.flatMap(script => script.js ?? []) ?? [];
    const contentScript = scripts.find(script => script.endsWith("content.js")) ?? "content.js";

    return contentScript.slice(0, - "content.js".length);
}

document.addEventListener(
    "DOMContentLoaded",
    () => {
        const manifest = browser.runtime.getManifest();
        const basePath = getExtensionBasePath();

        window.postMessage({
            type: "vencord:meta",
            meta: {
                EXTENSION_VERSION: manifest.version,
                EXTENSION_BASE_URL: browser.runtime.getURL(basePath),
                RENDERER_CSS_URL: browser.runtime.getURL(`${basePath}dist/Equicord.css`),
            }
        });
    },
    { once: true }
);
