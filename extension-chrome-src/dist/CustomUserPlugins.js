(function () {
    "use strict";

    const DB_NAME = "EquicordCustomUserPlugins";
    const STORE_NAME = "plugins";
    const STYLE_ID = "equicord-user-plugin-manager-style";
    const READY_EVENT = "equicord:userplugins-ready";
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
    const IGNORED_PATH_PARTS = new Set(["node_modules", ".git", ".github", "test", "tests", "__tests__", "docs"]);
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

    function getDirName(filePath) {
        const normalized = filePath.replace(/\\/g, "/");
        const index = normalized.lastIndexOf("/");
        return index === -1 ? "" : normalized.slice(0, index);
    }

    function joinPath(base, relative) {
        const parts = `${base ? `${base}/` : ""}${relative}`.replace(/\\/g, "/").split("/");
        const out = [];
        for (const part of parts) {
            if (!part || part === ".") continue;
            if (part === "..") out.pop();
            else out.push(part);
        }
        return out.join("/");
    }

    function getCssImportPaths(source) {
        const paths = new Set();
        const importRegex = /^\s*import\s+(?:[^"']+\s+from\s+)?["']([^"']+\.css(?:\?[^"']*)?)["'];?\s*$/gm;
        const sideEffectRegex = /^\s*import\s*["']([^"']+\.css(?:\?[^"']*)?)["'];?\s*$/gm;
        for (const regex of [importRegex, sideEffectRegex]) {
            let match;
            while ((match = regex.exec(source))) {
                paths.add(match[1].split("?")[0]);
            }
        }
        return [...paths];
    }

    async function fetchGithubCssForCandidate(owner, repo, branch, filePath, code, treePaths = []) {
        const css = [];
        const dir = getDirName(filePath);
        const cssImports = getCssImportPaths(code);
        const candidates = new Set(cssImports.map(cssPath => joinPath(dir, cssPath)));

        if (!candidates.size) {
            for (const name of ["style.css", "styles.css", "index.css", "plugin.css"]) {
                const nearby = joinPath(dir, name);
                if (!treePaths.length || treePaths.includes(nearby)) candidates.add(nearby);
            }
        }

        for (const cssPath of candidates) {
            try {
                const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${cssPath}`;
                const source = await fetchText(url);
                if (source.trim()) css.push({ path: cssPath, source });
            } catch {
                continue;
            }
        }

        return css;
    }

    function isUsableJavaScriptPath(filePath) {
        const normalized = filePath.replace(/\\/g, "/");
        if (!/\.m?js$/i.test(normalized)) return false;
        const parts = normalized.split("/");
        if (parts.some(part => IGNORED_PATH_PARTS.has(part))) return false;
        if (/(\.|-)d\.ts$/i.test(normalized)) return false;
        if (/\.(config|test|spec)\.m?js$/i.test(normalized)) return false;
        return true;
    }

    function scoreCandidatePath(filePath) {
        const normalized = filePath.replace(/\\/g, "/").toLowerCase();
        const fileName = normalized.split("/").pop() || "";
        let score = 0;

        if (CANDIDATE_FILES.includes(normalized)) score += 1000 - CANDIDATE_FILES.indexOf(normalized);
        if (normalized.includes("/dist/")) score += 300;
        if (normalized.includes("/build/")) score += 240;
        if (normalized.includes("/src/")) score -= 160;
        if (fileName === "index.js" || fileName === "index.mjs") score += 180;
        if (fileName === "plugin.js" || fileName === "plugin.mjs") score += 170;
        if (fileName === "userplugin.js" || fileName === "userplugin.mjs") score += 170;
        if (fileName === "bundle.js") score += 160;
        if (normalized.includes("plugin")) score += 80;
        score -= normalized.split("/").length * 3;

        return score;
    }

    function pickBestJavaScriptFile(paths) {
        const candidates = paths.filter(isUsableJavaScriptPath);
        candidates.sort((a, b) => scoreCandidatePath(b) - scoreCandidatePath(a));
        return candidates[0] || null;
    }

    async function getGithubDefaultBranch(owner, repo) {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { cache: "no-cache" });
        if (!response.ok) return null;
        const data = await response.json();
        return typeof data.default_branch === "string" ? data.default_branch : null;
    }

    async function fetchGithubTree(owner, repo, branch) {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { cache: "no-cache" });
        if (!response.ok) return null;
        const data = await response.json();
        return Array.isArray(data.tree) ? data.tree : null;
    }

    async function resolveGithubRepo(input) {
        const repo = parseGithubRepo(input);
        if (!repo) throw new Error("Paste a GitHub repository URL, owner/repo, raw GitHub URL, or direct JavaScript URL.");

        const defaultBranch = repo.branch ? null : await getGithubDefaultBranch(repo.owner, repo.repo).catch(() => null);
        const branches = repo.branch ? [repo.branch] : [...new Set([defaultBranch, ...DEFAULT_BRANCHES].filter(Boolean))];
        const prefix = repo.path ? `${repo.path.replace(/\/+$/, "")}/` : "";
        const files = CANDIDATE_FILES.map(file => `${prefix}${file}`);

        for (const branch of branches) {
            for (const file of files) {
                const candidate = await fetchGithubCandidate(repo.owner, repo.repo, branch, file);
                if (candidate) {
                    candidate.css = await fetchGithubCssForCandidate(repo.owner, repo.repo, branch, file, candidate.code);
                    return candidate;
                }
            }
        }

        for (const branch of branches) {
            try {
                const tree = await fetchGithubTree(repo.owner, repo.repo, branch);
                if (!tree) continue;
                const repoPrefix = repo.path ? `${repo.path.replace(/\/+$/, "")}/` : "";
                const paths = tree
                    .filter(entry => entry.type === "blob" && (!repoPrefix || entry.path.startsWith(repoPrefix)))
                    .map(entry => entry.path);
                const best = pickBestJavaScriptFile(paths);
                if (best) {
                    const candidate = await fetchGithubCandidate(repo.owner, repo.repo, branch, best);
                    if (candidate) {
                        candidate.css = await fetchGithubCssForCandidate(repo.owner, repo.repo, branch, best, candidate.code, paths);
                        return candidate;
                    }
                }

                if (paths.some(path => /\.(tsx?|jsx?)$/i.test(path)) && !paths.some(isUsableJavaScriptPath)) {
                    throw new Error("This GitHub repo only has source files, not a built plugin. Build it first and upload/paste the compiled JavaScript output.");
                }
            } catch (error) {
                warn("GitHub tree fallback failed", error);
                if (String(error?.message || error).includes("only has source files")) throw error;
            }
        }

        throw new Error("Could not find a compiled JavaScript plugin file. Add dist/index.js, index.js, plugin.js, userplugin.js, or upload a built plugin folder.");
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
        const cssNodes = [];

        for (const css of plugin.css || []) {
            if (!css?.source?.trim()) continue;
            const style = document.createElement("style");
            style.dataset.equicordUserPlugin = plugin.id;
            style.dataset.equicordUserPluginCss = css.path || "inline";
            style.textContent = css.source;
            document.head.append(style);
            cssNodes.push(style);
        }
        cleanup.push(() => cssNodes.forEach(node => node.remove()));

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
            : { url: normalizeRawUrl(plugin.source), code: await fetchText(normalizeRawUrl(plugin.source)), css: [] };
        return {
            ...plugin,
            url: resolved.url,
            code: resolved.code,
            css: resolved.css || [],
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
            name: resolved.name || guessName(resolved.filePath || trimmed),
            source: trimmed,
            sourceType,
            url: resolved.url,
            filePath: resolved.filePath,
            code: resolved.code,
            css: resolved.css || [],
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
            css: [],
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastLoadedAt: null,
            error: null
        };
        await applyPlugin(plugin);
        return plugin;
    }

    function groupFolderFiles(files) {
        const groups = new Map();
        for (const file of files) {
            const relativePath = file.webkitRelativePath || file.name;
            const parts = relativePath.split("/").filter(Boolean);
            const key = parts.length > 1 ? parts[0] : "__root__";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(file);
        }

        if (groups.size === 1) return groups;

        const rootFiles = groups.get("__root__") || [];
        if (rootFiles.length) groups.set("Root Plugin", rootFiles);
        groups.delete("__root__");
        return groups;
    }

    function pickBestFolderFile(files) {
        const candidates = files
            .map(file => ({ file, path: file.webkitRelativePath || file.name }))
            .filter(item => isUsableJavaScriptPath(item.path));

        candidates.sort((a, b) => scoreCandidatePath(b.path) - scoreCandidatePath(a.path));
        return candidates[0] || null;
    }

    async function readFolderCssForCandidate(files, best) {
        const byPath = new Map(files.map(file => [(file.webkitRelativePath || file.name).replace(/\\/g, "/"), file]));
        const code = await best.file.text();
        const dir = getDirName(best.path);
        const candidates = new Set(getCssImportPaths(code).map(cssPath => joinPath(dir, cssPath)));

        if (!candidates.size) {
            for (const name of ["style.css", "styles.css", "index.css", "plugin.css"]) {
                const nearby = joinPath(dir, name);
                if (byPath.has(nearby)) candidates.add(nearby);
            }
        }

        const css = [];
        for (const cssPath of candidates) {
            const file = byPath.get(cssPath);
            if (!file) continue;
            const source = await file.text();
            if (source.trim()) css.push({ path: cssPath, source });
        }

        return { code, css };
    }

    async function addFromFolderFiles(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return [];

        const added = [];
        const skipped = [];
        const sourceOnly = [];
        for (const [folderName, groupFiles] of groupFolderFiles(files)) {
            const best = pickBestFolderFile(groupFiles);
            if (!best) {
                if (groupFiles.some(file => /\.(tsx?|jsx?)$/i.test(file.name))) sourceOnly.push(folderName);
                skipped.push(folderName);
                continue;
            }
            const { code, css } = await readFolderCssForCandidate(groupFiles, best);

            const plugin = {
                id: idFrom(best.path),
                name: folderName === "__root__" ? guessName(best.path) : guessName(folderName),
                source: best.path,
                sourceType: "local-folder",
                url: null,
                filePath: best.path,
                code,
                css,
                enabled: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                lastLoadedAt: null,
                error: null
            };
            await applyPlugin(plugin);
            added.push(plugin);
        }

        if (!added.length) {
            if (sourceOnly.length) {
                throw new Error(`The selected folder only has source files, not a built plugin: ${sourceOnly.join(", ")}. Build it first, then upload the compiled JavaScript output.`);
            }
            throw new Error(`No compiled JavaScript plugin files found${skipped.length ? ` in: ${skipped.join(", ")}` : ""}. Build TypeScript plugins first, then upload the folder again.`);
        }

        return added;
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
.equp-title {
    margin: 0;
    font-size: 18px;
    line-height: 1.2;
    font-weight: 700;
    color: var(--header-primary, #f2f3f5);
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
.equp-button {
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
.equp-settings-panel {
    margin: 16px 0;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: var(--background-secondary, #2b2d31);
}
.equp-settings-panel .equp-title {
    font-size: 16px;
}
.equp-settings-panel .equp-list {
    max-height: 320px;
    overflow: auto;
}
@media (max-width: 680px) {
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

    function createSettingsPanel() {
        const panel = el("section", { id: "equp-settings-panel", className: "equp-settings-panel" });
        const status = el("p", { className: "equp-status" });
        const input = el("input", {
            className: "equp-input",
            placeholder: "Paste GitHub repo, owner/repo, raw .js URL, or direct .js URL"
        });
        const fileInput = el("input", { className: "equp-file", type: "file", accept: ".js,.mjs" });
        const folderInput = el("input", { className: "equp-file", type: "file", webkitdirectory: "", directory: "", multiple: "" });
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

                const actions = [el("label", { className: "equp-switch" }, [enabled, "Enabled"])];

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
                if (plugin.css?.length) details.push(el("p", { className: "equp-card-meta", text: `CSS loaded: ${plugin.css.map(css => css.path || "inline").join(", ")}` }));
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

        folderInput.addEventListener("change", () => runAction("Uploading folder", async () => {
            const added = await addFromFolderFiles(folderInput.files);
            for (const plugin of added) toast(`Added ${plugin.name}`, "SUCCESS");
            folderInput.value = "";
        }));

        panel.append(
            el("div", { className: "equp-row wrap" }, [
                el("h2", { className: "equp-title", text: "Custom User Plugins" })
            ]),
            el("div", { className: "equp-row wrap" }, [
                input,
                addButton,
                el("button", { className: "equp-button secondary", text: "Upload File", onclick: () => fileInput.click() }),
                el("button", { className: "equp-button secondary", text: "Upload Folder", onclick: () => folderInput.click() }),
                fileInput,
                folderInput
            ]),
            el("p", { className: "equp-help", text: "Paste a plugin GitHub repo or JavaScript URL here, or upload a built plugin folder. TypeScript source-only plugins must be built first." }),
            status,
            list
        );

        listeners.add(renderList);
        renderList();
        return panel;
    }

    function findSettingsPluginHost() {
        if (document.getElementById("equp-settings-panel")) return null;

        const pluginGrid = document.querySelector('[class*="vc-plugins-grid"], [class*="vc-plugins_"], [class*="vc-plugins-"]');
        if (pluginGrid?.parentElement) return pluginGrid.parentElement;

        const headings = Array.from(document.querySelectorAll("h1,h2,h3,[class*='title']"));
        const pluginHeading = headings.find(node => {
            if (node.closest("#equp-settings-panel, .equp-settings-panel")) return false;
            const text = node.textContent || "";
            return /^plugins$/i.test(text.trim()) || /equicord plugins|plugin management/i.test(text);
        });
        if (!pluginHeading) return null;

        const candidate = pluginHeading.closest("section, main, [class*='content'], [class*='Content']");
        return candidate || pluginHeading.parentElement;
    }

    function mountSettingsPanel() {
        ensureStyle();
        const host = findSettingsPluginHost();
        if (!host) return;
        const panel = createSettingsPanel();
        const firstGrid = host.querySelector('[class*="vc-plugins-grid"], [class*="grid"]');
        if (firstGrid) host.insertBefore(panel, firstGrid);
        else host.append(panel);
    }

    function startSettingsObserver() {
        let pending = false;
        const schedule = () => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                mountSettingsPanel();
            });
        };

        schedule();
        const observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    async function boot() {
        plugins = await readAllPlugins();
        emit();
        for (const plugin of plugins) {
            if (plugin.enabled) await applyPlugin(plugin, { persist: true });
        }
        startSettingsObserver();
        window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: { plugins } }));
        log(`Loaded ${plugins.length} custom user plugin entr${plugins.length === 1 ? "y" : "ies"}.`);
    }

    window.EquicordUserPluginManager = {
        get plugins() {
            return [...plugins];
        },
        addFromGithub,
        addFromFile,
        addFromFolderFiles,
        refreshPlugin,
        start: startPlugin,
        stop: stopRuntime,
        subscribe(listener) {
            listeners.add(listener);
            listener([...plugins]);
            return () => listeners.delete(listener);
        },
        mountSettingsPanel
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => boot().catch(error => fail("Boot failed", error)), { once: true });
    } else {
        boot().catch(error => fail("Boot failed", error));
    }
})();
