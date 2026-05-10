if (typeof browser === "undefined") {
    var browser = chrome;
}

function getExtensionBasePath() {
    const manifest = browser.runtime.getManifest();
    const scripts = manifest.content_scripts?.flatMap(script => script.js ?? []) ?? [];
    const contentScript = scripts.find(script => script.endsWith("content.js")) ?? "content.js";

    return contentScript.slice(0, - "content.js".length);
}

function getExtensionMeta() {
    const manifest = browser.runtime.getManifest();
    const basePath = getExtensionBasePath();

    return {
        EXTENSION_VERSION: manifest.version,
        EXTENSION_BASE_URL: browser.runtime.getURL(basePath),
        RENDERER_CSS_URL: browser.runtime.getURL(`${basePath}dist/Equicord.css`),
    };
}

function postExtensionMeta() {
    window.postMessage({
        type: "vencord:meta",
        meta: getExtensionMeta()
    });
}

window.addEventListener("message", event => {
    if (event.data?.type !== "equicord:get-meta") return;
    postExtensionMeta();
});

document.addEventListener(
    "DOMContentLoaded",
    postExtensionMeta,
    { once: true }
);
