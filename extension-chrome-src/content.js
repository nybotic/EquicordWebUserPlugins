if (typeof browser === "undefined") {
    var browser = chrome;
}

function getExtensionBasePath() {
    const manifest = browser.runtime.getManifest();
    const scripts = manifest.content_scripts?.flatMap(script => script.js ?? []) ?? [];
    const contentScript = scripts.find(script => script.endsWith("content.js")) ?? "content.js";

    return contentScript.slice(0, - "content.js".length);
}

function injectRendererCss() {
    if (document.getElementById("equicord-renderer-css")) return;

    const basePath = getExtensionBasePath();
    const link = document.createElement("link");
    link.id = "equicord-renderer-css";
    link.rel = "stylesheet";
    link.href = browser.runtime.getURL(`${basePath}dist/Equicord.css`);

    (document.head || document.documentElement).append(link);
}

injectRendererCss();

document.addEventListener(
    "DOMContentLoaded",
    () => {
        const manifest = browser.runtime.getManifest();
        const basePath = getExtensionBasePath();

        injectRendererCss();
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
