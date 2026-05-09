(function () {
    "use strict";

    const DB_NAME = "EquicordCustomUserPlugins";
    const STORE_NAME = "plugins";
    const MANAGER_ID = "equicord-user-plugin-manager";
    const STYLE_ID = "equicord-user-plugin-manager-style";
    const READY_EVENT = "equicord:userplugins-ready";
    const TOGGLE_HOTKEY = { ctrlKey: true, shiftKey: true, code: "KeyU" };
    const DEFAULT_BRANCHES = ["main", "master"];
    const CANDIDATE_FILES = [
        "dist/index.js",
        "dist/plugin.js",
        "build/index.js",
        "bundle.js",
        "index.js",
        "plugin.js",
        "userplugin.js"
    ];

    const log = (...args) => console.log("%c Equicord %c UserPlugins ", "background:#a6d189;color:#000;font-weight:bold;border-radius:4px", "background:#d2acf5;color:#000;font-weight:bold;border-radius:4px", ...args);
    const warn = (...args) => console.warn("%c Equicord %c UserPlugins ", "background:#e5c890;color:#000;font-weight:bold;border-radius:4px", "background:#d2acf5;color:#000;font-weight:bold;border-radius:4px", ...args);
    const fail = (...args) => console.error("%c Equicord %c UserPlugins ", "background:#e78284;color:#000;font-weight:bold;border-radius:4px", "background:#d2acf5;color:#000;font-weight:bold;border-radius:4px", ...args);

    let dbPromise;
    let plugins = [];
    const runtimes = new Map();
    const listeners = new Set();

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "id" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return dbPromise;
    }

    async function withStore(mode, callback) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode);
            const store = tx.objectStore(STORE_NAME);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            try {
                result = callback(store);
            } catch (error) {
                reject(error);
            }
        });
    }

    function req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function readAllPlugins() {
        return withStore("readonly", store => req(store.getAll()));
    }

    async function savePlugin(plugin) {
        await withStore("readwrite", store => store.put(plugin));
    }

    async function deletePlugin(id) {
        await withStore("readwrite", store => store.delete(id));
    }

    function emit() {
        listeners.forEach(listener => {
            try {
                listener([...plugins]);
            } catch (error) {
                warn("Listener failed", error);
            }
        });
    }

    function idFrom(value) {
        const base = `${value}:${Date.now()}:${Math.random()}`;
        let hash = 0;
        for (let i = 0; i < base.length; i++) hash = Math.imul(31, hash) + base.charCodeAt(i) | 0;
        return `up_${Math.abs(hash).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }

    function guessName(input, fallback = "Custom User Plugin") {
        const clean = input.split(/[?#]/)[0].replace(/\/+$/, "");
        const part = clean.split("/").filter(Boolean).pop();
        return (part || fallback).replace(/\.(user\.)?(plugin\.)?m?js$/i, "").replace(/[-_]+/g, " ").trim() || fallback;
    }

    function normalizeRawUrl(url) {
        const parsed = new URL(url);
        if (parsed.hostname === "github.com") {
            const parts = parsed.pathname.split("/").filter(Boolean);
            const blobIndex = parts.indexOf("blob");
            if (parts.length >= 5 && blobIndex === 2) {
                const owner = parts[0];
                const repo = parts[1];
                const branch = parts[3];
                const filePath = parts.slice(4).join("/");
                return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
            }
        }
        return url;
    }

    function parseGithubRepo(input) {
        let url;
        try {
            url = new URL(input);
        } catch {
            const compact = input.match(/^([\w.-]+)\/([\w.-]+)(?:#(.+))?$/);
            if (!compact) return null;
            return { owner: compact[1], repo: compact[2], branch: compact[3] || null, path: "" };
        }

        if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length < 2) return null;
        const treeIndex = parts.indexOf("tree");
        return {
            owner: parts[0],
            repo: parts[1],
            branch: treeIndex === 2 ? parts[3] : null,
            path: treeIndex === 2 ? parts.slice(4).join("/") : ""
        };
    }

    async function fetchText(url) {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.text();
    }

    async function fetchGithubCandidate(owner, repo, branch, filePath) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) return null;
        const text = await response.text();
        if (!text.trim()) return null;
        return { url, code: text, filePath };
    }

    async function resolveGithubRepo(input) {
        const repo = parseGithubRepo(input);
        if (!repo) throw new Error("Paste a GitHub repository URL, owner/repo, raw GitHub URL, or direct JavaScript URL.");

        const branches = repo.branch ? [repo.branch] : DEFAULT_BRANCHES;
        const prefix = repo.path ? `${repo.path.replace(/\/+$/, "")}/` : "";
        const files = CANDIDATE_FILES.map(file => `${prefix}${file}`);

        for (const branch of branches) {
            for (const file of files) {
                const candidate = await fetchGithubCandidate(repo.owner, repo.repo, branch, file);
                if (candidate) return candidate;
            }
        }

        const apiBranch = repo.branch || "HEAD";
        const apiPath = repo.path ? `/${repo.path}` : "";
        try {
            const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents${apiPath}?ref=${encodeURIComponent(apiBranch)}`;
            const response = await fetch(apiUrl, { cache: "no-cache" });
            if (response.ok) {
                const entries = await response.json();
                const list = Array.isArray(entries) ? entries : [entries];
                const jsFile = list.find(entry => entry.type === "file" && /\.m?js$/i.test(entry.name));
                if (jsFile?.download_url) {
                    return {
                        url: jsFile.download_url,
                        code: await fetchText(jsFile.download_url),
                        filePath: jsFile.path
                    };
                }
            }
        } catch (error) {
            warn("GitHub API fallback failed", error);
        }

        throw new Error("Could not find a compiled JavaScript plugin file. Add dist/index.js, index.js, plugin.js, userplugin.js, or paste a raw .js URL.");
    }

    function transformSource(source) {
        let code = source.replace(/^\s*import\s+[^;]+;?\s*$/gm, "");
        code = code.replace(/\bexport\s+default\s+/g, "module.exports = ");
        code = code.replace(/\bexport\s+\{[^}]+\};?\s*$/gm, "");
        return code;
    }

    function makeSandbox(plugin, registration) {
        const api = {
            Vencord: window.Vencord,
            Webpack: window.Vencord?.Webpack,
            Common: window.Vencord?.Webpack?.Common,
            Settings: window.Vencord?.Settings,
            Native: window.VencordNative,
            plugin,
            register(definition) {
                registration.definition = definition;
                return definition;
            },
            toast(message, type = "MESSAGE") {
                const toasts = window.Vencord?.Webpack?.Common?.Toasts;
                const toastType = toasts?.Type?.[type] || toasts?.Type?.MESSAGE;
                if (toasts?.show) {
                    toasts.show({ id: toasts.genId(), message, type: toastType });
                } else {
                    log(message);
                }
            }
        };
        return api;
    }

    async function stopRuntime(id) {
        const runtime = runtimes.get(id);
        if (!runtime) return;
        try {
            await runtime.stop?.();
            runtime.cleanup.forEach(cleanup => {
                try {
                    cleanup();
                } catch (error) {
                    warn("Cleanup failed", error);
                }
            });
        } finally {
            runtimes.delete(id);
        }
    }

    async function startPlugin(plugin) {
        await stopRuntime(plugin.id);

        const registration = { definition: null };
        const cleanup = [];
        const module = { exports: {} };
        const exports = module.exports;
        const api = makeSandbox(plugin, registration);
        const code = transformSource(plugin.code || "");

        const previousGlobal = window.EquicordUserPlugins;
        window.EquicordUserPlugins = {
            ...(previousGlobal || {}),
            register: api.register,
            api
        };

        try {
            const runner = new Function(
                "module",
                "exports",
                "api",
            "Vencord",
            "VencordNative",
            "EquicordUserPlugins",
            "definePlugin",
            "registerPlugin",
            `"use strict";\n${code}\n//# sourceURL=equicord-user-plugin-${plugin.id}.js`
        );
            runner(module, exports, api, window.Vencord, window.VencordNative, window.EquicordUserPlugins, value => value, api.register);
        } finally {
            if (previousGlobal) {
                window.EquicordUserPlugins = previousGlobal;
            }
        }

        const definition = registration.definition || module.exports?.default || module.exports;
        const normalized = typeof definition === "function" ? { name: plugin.name, start: definition } : definition;
        if (!normalized || typeof normalized !== "object") {
            throw new Error("Plugin did not export an object or call EquicordUserPlugins.register(...).");
        }

        const context = {
            api,
            Vencord: window.Vencord,
            VencordNative: window.VencordNative,
            plugin,
            cleanup(callback) {
                if (typeof callback === "function") cleanup.push(callback);
            }
        };

        if (typeof normalized.start === "function") {
            await normalized.start.call(normalized, context);
        }

        runtimes.set(plugin.id, {
            stop: typeof normalized.stop === "function" ? () => normalized.stop.call(normalized, context) : null,
            cleanup,
            definition: normalized
        });
    }

    async function refreshPlugin(plugin) {
        if (plugin.sourceType !== "github" && plugin.sourceType !== "url") return plugin;
        const resolved = plugin.sourceType === "github"
            ? await resolveGithubRepo(plugin.source)
            : { url: normalizeRawUrl(plugin.source), code: await fetchText(normalizeRawUrl(plugin.source)) };
        return {
            ...plugin,
            url: resolved.url,
            code: resolved.code,
            filePath: resolved.filePath || plugin.filePath,
            updatedAt: Date.now()
        };
    }

    async function applyPlugin(plugin, { persist = true } = {}) {
        let next = { ...plugin, error: null };
        try {
            if (next.enabled) await startPlugin(next);
            else await stopRuntime(next.id);
            next.lastLoadedAt = next.enabled ? Date.now() : next.lastLoadedAt;
        } catch (error) {
            next.error = error?.message || String(error);
            await stopRuntime(next.id);
            fail(`Failed to load ${next.name}`, error);
        }

        const index = plugins.findIndex(item => item.id === next.id);
        if (index === -1) plugins.push(next);
        else plugins[index] = next;
        if (persist) await savePlugin(next);
        emit();
        return next;
    }

    async function addFromGithub(input) {
        const trimmed = input.trim();
        if (!trimmed) throw new Error("Paste a GitHub repository or JavaScript URL first.");

        let resolved;
        let sourceType;
        if (/^https?:\/\/.+\.m?js(?:[?#].*)?$/i.test(trimmed) || /raw\.githubusercontent\.com/.test(trimmed) || /github\.com\/.+\/blob\//.test(trimmed)) {
            const url = normalizeRawUrl(trimmed);
            resolved = { url, code: await fetchText(url), filePath: new URL(url).pathname.split("/").pop() };
            sourceType = "url";
        } else {
            resolved = await resolveGithubRepo(trimmed);
            sourceType = "github";
        }

        const plugin = {
            id: idFrom(trimmed),
            name: guessName(resolved.filePath || trimmed),
            source: trimmed,
            sourceType,
            url: resolved.url,
            filePath: resolved.filePath,
            code: resolved.code,
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastLoadedAt: null,
            error: null
        };

        await applyPlugin(plugin);
        return plugin;
    }

    async function addFromFile(file) {
        if (!file) return null;
        if (!/\.m?js$/i.test(file.name)) throw new Error("Upload a compiled .js or .mjs plugin file.");
        const plugin = {
            id: idFrom(file.name),
            name: guessName(file.name),
            source: file.name,
            sourceType: "local",
            url: null,
            filePath: file.name,
            code: await file.text(),
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastLoadedAt: null,
            error: null
        };
        await applyPlugin(plugin);
        return plugin;
    }

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === "className") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key === "html") node.innerHTML = value;
            else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
            else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        }
        for (const child of Array.isArray(children) ? children : [children]) {
            if (child == null) continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        document.head.append(el("style", { id: STYLE_ID, text: `
#${MANAGER_ID} {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: none;
    font-family: var(--font-primary, Inter, Arial, sans-serif);
    color: var(--text-normal, #dcddde);
}
#${MANAGER_ID}.open { display: block; }
.equp-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.58);
}
.equp-modal {
    position: absolute;
    right: 28px;
    top: 72px;
    width: min(720px, calc(100vw - 32px));
    max-height: calc(100vh - 104px);
    display: flex;
    flex-direction: column;
    background: var(--background-primary, #313338);
    border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
    overflow: hidden;
}
.equp-header, .equp-footer {
    padding: 16px;
    background: var(--background-secondary, #2b2d31);
}
.equp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}
.equp-title {
    margin: 0;
    font-size: 18px;
    line-height: 1.2;
    font-weight: 700;
    color: var(--header-primary, #f2f3f5);
}
.equp-body {
    padding: 16px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.equp-row {
    display: flex;
    gap: 8px;
    align-items: center;
}
.equp-row.wrap { flex-wrap: wrap; }
.equp-input {
    flex: 1 1 260px;
    min-width: 0;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--input-border, rgba(255, 255, 255, 0.14));
    border-radius: 4px;
    background: var(--input-background, #1e1f22);
    color: var(--text-normal, #dcddde);
    outline: none;
}
.equp-button, .equp-floating {
    border: 0;
    border-radius: 4px;
    background: var(--brand-500, #5865f2);
    color: #fff;
    font-weight: 700;
    cursor: pointer;
}
.equp-button {
    height: 36px;
    padding: 0 12px;
}
.equp-button.secondary { background: var(--background-modifier-selected, #404249); }
.equp-button.danger { background: var(--button-danger-background, #da373c); }
.equp-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}
.equp-floating {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 2147483646;
    width: 44px;
    height: 44px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
.equp-help, .equp-status {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-muted, #949ba4);
}
.equp-status.error { color: var(--text-feedback-critical, #ffb4ab); }
.equp-status.ok { color: var(--status-positive, #23a55a); }
.equp-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.equp-card {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.12));
    border-radius: 6px;
    background: var(--background-secondary, #2b2d31);
}
.equp-card-title {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 700;
    color: var(--header-primary, #f2f3f5);
}
.equp-card-meta {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--text-muted, #949ba4);
    font-size: 12px;
    line-height: 1.4;
}
.equp-card-actions {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.equp-switch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted, #949ba4);
}
.equp-switch input { margin: 0; }
.equp-file {
    display: none;
}
@media (max-width: 680px) {
    .equp-modal {
        left: 12px;
        right: 12px;
        top: 56px;
        width: auto;
    }
    .equp-card {
        grid-template-columns: 1fr;
    }
    .equp-card-actions {
        justify-content: flex-start;
    }
}
` }));
    }

    function toast(message, type = "MESSAGE") {
        const toasts = window.Vencord?.Webpack?.Common?.Toasts;
        const toastType = toasts?.Type?.[type] || toasts?.Type?.MESSAGE;
        if (toasts?.show) toasts.show({ id: toasts.genId(), message, type: toastType });
        else log(message);
    }

    function createManager() {
        ensureStyle();
        if (document.getElementById(MANAGER_ID)) return;

        const root = el("div", { id: MANAGER_ID });
        const status = el("p", { className: "equp-status" });
        const input = el("input", {
            className: "equp-input",
            placeholder: "GitHub repo, owner/repo, raw GitHub .js URL, or direct .js URL"
        });
        const fileInput = el("input", { className: "equp-file", type: "file", accept: ".js,.mjs" });
        const list = el("div", { className: "equp-list" });

        async function runAction(label, action) {
            status.className = "equp-status";
            status.textContent = `${label}...`;
            try {
                const result = await action();
                status.className = "equp-status ok";
                status.textContent = "Done.";
                renderList();
                return result;
            } catch (error) {
                status.className = "equp-status error";
                status.textContent = error?.message || String(error);
                throw error;
            }
        }

        function close() {
            root.classList.remove("open");
        }

        function renderList() {
            list.replaceChildren();
            if (!plugins.length) {
                list.append(el("p", { className: "equp-help", text: "No custom user plugins installed yet." }));
                return;
            }

            for (const plugin of plugins.slice().sort((a, b) => a.name.localeCompare(b.name))) {
                const enabled = el("input", { type: "checkbox" });
                enabled.checked = !!plugin.enabled;
                enabled.addEventListener("change", () => runAction("Updating plugin", async () => {
                    await applyPlugin({ ...plugin, enabled: enabled.checked });
                    toast(`${enabled.checked ? "Enabled" : "Disabled"} ${plugin.name}`, "SUCCESS");
                }));

                const actions = [
                    el("label", { className: "equp-switch" }, [enabled, "Enabled"])
                ];

                if (plugin.sourceType !== "local") {
                    actions.push(el("button", { className: "equp-button secondary", text: "Refresh", onclick: () => runAction("Refreshing plugin", async () => {
                        const refreshed = await refreshPlugin(plugin);
                        await applyPlugin(refreshed);
                        toast(`Refreshed ${plugin.name}`, "SUCCESS");
                    }) }));
                }

                actions.push(el("button", { className: "equp-button danger", text: "Remove", onclick: () => runAction("Removing plugin", async () => {
                    await stopRuntime(plugin.id);
                    plugins = plugins.filter(item => item.id !== plugin.id);
                    await deletePlugin(plugin.id);
                    emit();
                    toast(`Removed ${plugin.name}`, "SUCCESS");
                }) }));

                const details = [
                    el("h3", { className: "equp-card-title", text: plugin.name }),
                    el("p", { className: "equp-card-meta", text: `${plugin.sourceType}${plugin.filePath ? ` - ${plugin.filePath}` : ""}` })
                ];
                if (plugin.url) details.push(el("p", { className: "equp-card-meta", text: plugin.url }));
                if (plugin.error) details.push(el("p", { className: "equp-status error", text: plugin.error }));

                list.append(el("div", { className: "equp-card" }, [
                    el("div", {}, details),
                    el("div", { className: "equp-card-actions" }, actions)
                ]));
            }
        }

        const addButton = el("button", { className: "equp-button", text: "Add", onclick: () => runAction("Adding plugin", async () => {
            const plugin = await addFromGithub(input.value);
            input.value = "";
            toast(`Added ${plugin.name}`, "SUCCESS");
        }) });

        input.addEventListener("keydown", event => {
            if (event.key === "Enter") addButton.click();
        });

        fileInput.addEventListener("change", () => runAction("Uploading plugin", async () => {
            for (const file of Array.from(fileInput.files || [])) {
                const plugin = await addFromFile(file);
                if (plugin) toast(`Added ${plugin.name}`, "SUCCESS");
            }
            fileInput.value = "";
        }));

        root.append(
            el("div", { className: "equp-backdrop", onclick: close }),
            el("section", { className: "equp-modal", role: "dialog", "aria-label": "Custom User Plugins" }, [
                el("header", { className: "equp-header" }, [
                    el("h2", { className: "equp-title", text: "Custom User Plugins" }),
                    el("button", { className: "equp-button secondary", text: "Close", onclick: close })
                ]),
                el("div", { className: "equp-body" }, [
                    el("div", { className: "equp-row wrap" }, [
                        input,
                        addButton,
                        el("button", { className: "equp-button secondary", text: "Upload", onclick: () => fileInput.click() }),
                        fileInput
                    ]),
                    el("p", { className: "equp-help", text: "GitHub repos are scanned for compiled JavaScript files such as dist/index.js, index.js, plugin.js, or userplugin.js. TypeScript source-only repos need to be built first or uploaded as JavaScript." }),
                    status,
                    list
                ]),
                el("footer", { className: "equp-footer" }, [
                    el("p", { className: "equp-help", text: "Plugin scripts run in Discord's page context with access to window.Vencord, window.VencordNative, and EquicordUserPlugins.register(...). Use only code you trust." })
                ])
            ])
        );

        document.documentElement.append(root);

        const floating = el("button", {
            className: "equp-floating",
            title: "Custom User Plugins (Ctrl+Shift+U)",
            text: "UP",
            onclick: () => {
                renderList();
                root.classList.toggle("open");
            }
        });
        document.documentElement.append(floating);

        listeners.add(renderList);
        renderList();
    }

    async function boot() {
        plugins = await readAllPlugins();
        emit();
        for (const plugin of plugins) {
            if (plugin.enabled) await applyPlugin(plugin, { persist: true });
        }
        createManager();
        window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: { plugins } }));
        log(`Loaded ${plugins.length} custom user plugin entr${plugins.length === 1 ? "y" : "ies"}.`);
    }

    window.EquicordUserPluginManager = {
        get plugins() {
            return [...plugins];
        },
        addFromGithub,
        addFromFile,
        refreshPlugin,
        start: startPlugin,
        stop: stopRuntime,
        subscribe(listener) {
            listeners.add(listener);
            listener([...plugins]);
            return () => listeners.delete(listener);
        },
        open() {
            createManager();
            document.getElementById(MANAGER_ID)?.classList.add("open");
        },
        close() {
            document.getElementById(MANAGER_ID)?.classList.remove("open");
        }
    };

    window.addEventListener("keydown", event => {
        if (event.ctrlKey === TOGGLE_HOTKEY.ctrlKey && event.shiftKey === TOGGLE_HOTKEY.shiftKey && event.code === TOGGLE_HOTKEY.code) {
            event.preventDefault();
            window.EquicordUserPluginManager.open();
        }
    }, true);

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => boot().catch(error => fail("Boot failed", error)), { once: true });
    } else {
        boot().catch(error => fail("Boot failed", error));
    }
})();
