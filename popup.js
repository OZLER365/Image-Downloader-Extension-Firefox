globalThis.browser = chrome;
const isAndroid = /Android/i.test(navigator.userAgent);
if (isAndroid) document.documentElement.classList.add("android");

const MIN_SIZE = 50;
const PLACEHOLDER_SVG = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBmaWxsPSIjZWRlZGVkIiBkPSJNMCAwaDI0djI0SDB6Ii8+PC9zdmc+";

// --- IndexedDB Local Cache ---
const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("ImageDownloaderCache", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("images", { keyPath: "url" });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
});
async function cacheImageData(url, dataUrl) {
    try { (await dbPromise).transaction("images","readwrite").objectStore("images").put({ url, dataUrl, timestamp: Date.now() }); } catch {}
}
async function getCachedImageData(url) {
    try {
        const db = await dbPromise;
        return new Promise(resolve => {
            const req = db.transaction("images","readonly").objectStore("images").get(url);
            req.onsuccess = () => resolve(req.result ? req.result.dataUrl : null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}
async function clearAllLocalCache() {
    try { (await dbPromise).transaction("images","readwrite").objectStore("images").clear(); } catch {}
}

let images = [], currentTabId = null, currentTabUrl = null, pageTitle = "images";
let renameMode = true, fetchMode = 'default', saveTimeout = null;
let renderQueue = [], targetScrollPosition = 0, sortOrder = null, uidCounter = 0;
let unscrambleMap = {}, unscrambleTotal = 0, unscrambleDone = 0;
let isDownloading = false;

const dom = {
    status: document.getElementById("status"),
    gridContainer: document.getElementById("grid-container"),
    grid: document.getElementById("grid"),
    toggleBtn: document.getElementById("toggleSelect"),
    tracker: document.getElementById("tracker-pill"),
    folderName: document.getElementById("folderName"),
    renameToggle: document.getElementById("renameToggle"),
    networkToggle: document.getElementById("networkToggle"),
    sortBtn: document.getElementById("sortBtn"),
    downloadBtn: document.getElementById("download"),
    zipBtn: document.getElementById("zip"),
    clearCache: document.getElementById("clearCache"),
    widthInputMin: document.getElementById("widthInputMin"),
    widthInputMax: document.getElementById("widthInputMax"),
    heightInputMin: document.getElementById("heightInputMin"),
    heightInputMax: document.getElementById("heightInputMax"),
    widthSliderMin: document.getElementById("widthSliderMin"),
    widthSliderMax: document.getElementById("widthSliderMax"),
    heightSliderMin: document.getElementById("heightSliderMin"),
    heightSliderMax: document.getElementById("heightSliderMax"),
    widthTrack: document.getElementById("widthTrack"),
    heightTrack: document.getElementById("heightTrack"),
    widthCheckMin: document.getElementById("widthCheckMin"),
    widthCheckMax: document.getElementById("widthCheckMax"),
    heightCheckMin: document.getElementById("heightCheckMin"),
    heightCheckMax: document.getElementById("heightCheckMax"),
    settingsBtn: document.getElementById("settingsBtn"),
    settingsPanel: document.getElementById("settings-panel"),
    closeSettings: document.getElementById("closeSettings"),
    modeDefault: document.getElementById("modeDefault"),
    modeNetwork: document.getElementById("modeNetwork"),
    modeBlob: document.getElementById("modeBlob")
};

const idleCallback = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
let uiUpdateTimer = null;
function debounceUpdateUI() {
    if (uiUpdateTimer) return;
    uiUpdateTimer = requestAnimationFrame(() => { updateUI(false); uiUpdateTimer = null; });
}

class AsyncQueue {
    constructor(concurrency) { this.concurrency = concurrency; this.running = 0; this.queue = []; this.onStart = null; this.onEmpty = null; }
    push(task) {
        if (this.running === 0 && this.queue.length === 0 && this.onStart) this.onStart();
        this.queue.push(task); this.next();
    }
    next() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift(); this.running++;
            task().finally(() => {
                this.running--; this.next();
                if (this.running === 0 && this.queue.length === 0 && this.onEmpty) this.onEmpty();
            });
        }
    }
}
const fetchQueue = new AsyncQueue(4);
const unscrambleQueue = new AsyncQueue(1);
const contentHashes = new Set();
const hashQueue = new AsyncQueue(4);

hashQueue.onStart = () => { if (dom.status.textContent === "Ready" || dom.status.textContent === "Scan done") dom.status.textContent = "Removing duplicates..."; };
hashQueue.onEmpty = () => { if (dom.status.textContent === "Removing duplicates...") dom.status.textContent = "Ready"; };

async function computeSHA256(blob) {
    try {
        const arr = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
        let hex = '';
        for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
        return hex;
    } catch { return null; }
}

function queueForHashing(img, item) {
    if (img.hashChecked || img.filtered || img.sizeFiltered) return;
    img.hashChecked = true;
    hashQueue.push(async () => {
        if (img.sha256) {
            if (contentHashes.has(img.sha256) && !img.isFirstHashInstance) {
                img.filtered = true; img.hashFiltered = true; img.selected = false;
                if (item && item.parentNode) item.parentNode.removeChild(item);
                debounceUpdateUI();
            } else { contentHashes.add(img.sha256); img.isFirstHashInstance = true; }
            return;
        }
        try {
            const blob = await getBlobForDownload(img);
            if (!blob) return;
            const hash = await computeSHA256(blob);
            if (!hash) return;
            img.sha256 = hash;
            if (contentHashes.has(hash)) {
                img.filtered = true; img.hashFiltered = true; img.selected = false;
                if (item && item.parentNode) item.parentNode.removeChild(item);
                debounceUpdateUI();
            } else { contentHashes.add(hash); img.isFirstHashInstance = true; }
        } catch {}
    });
}

function updateProgress() {
    if (unscrambleTotal > 0) {
        dom.status.textContent = `Descrambling ${unscrambleDone}/${unscrambleTotal}...`;
        if (unscrambleDone >= unscrambleTotal) {
            setTimeout(() => { if (unscrambleDone >= unscrambleTotal) { dom.status.textContent = "Ready"; unscrambleTotal = 0; unscrambleDone = 0; } }, 1500);
        }
    }
}

function saveState(immediate = false) {
    clearTimeout(saveTimeout);
    const doSave = () => {
        if (!currentTabId) return;
        const lightImages = images.map(img => {
            const copy = { ...img };
            copy.queuedForUnscramble = false;
            if (copy.unscrambledUrl) delete copy.unscrambledUrl;
            if (copy.displayUrl && copy.displayUrl.startsWith('data:')) copy.displayUrl = copy.url;
            return copy;
        });
        idleCallback(() => {
            browser.runtime.sendMessage({
                type: "SAVE_STATE", tabId: currentTabId,
                state: { images: lightImages, pageTitle, scrollPosition: dom.gridContainer.scrollTop, tabUrl: currentTabUrl }
            }).catch(() => {});
        }, { timeout: 2000 });
    };
    if (immediate) doSave(); else saveTimeout = setTimeout(doSave, 1500);
}
window.addEventListener("pagehide", () => saveState(true));
window.addEventListener("blur", () => saveState(true));

function clearAllCache() {
    for (let i = 0; i < images.length; i++) {
        if (images[i].unscrambledUrl && images[i].unscrambledUrl.startsWith('blob:')) URL.revokeObjectURL(images[i].unscrambledUrl);
        if (images[i].displayUrl && images[i].displayUrl.startsWith('blob:')) URL.revokeObjectURL(images[i].displayUrl);
    }
    images = []; uidCounter = 0; unscrambleTotal = 0; unscrambleDone = 0; contentHashes.clear(); renderQueue = [];
    dom.grid.innerHTML = "";
}

function updateSliderTrack(track, minInput, maxInput) {
    const min = parseInt(minInput.min, 10), max = parseInt(minInput.max, 10);
    const vMin = parseInt(minInput.value, 10), vMax = parseInt(maxInput.value, 10);
    const p1 = Math.max(0, Math.min(100, ((vMin - min) / (max - min)) * 100));
    const p2 = Math.max(0, Math.min(100, ((vMax - min) / (max - min)) * 100));
    track.style.left = p1 + "%"; track.style.width = (p2 - p1) + "%";
}

function updateInputStates() {
    dom.widthInputMin.disabled = dom.widthSliderMin.disabled = !dom.widthCheckMin.checked;
    dom.widthInputMax.disabled = dom.widthSliderMax.disabled = !dom.widthCheckMax.checked;
    dom.heightInputMin.disabled = dom.heightSliderMin.disabled = !dom.heightCheckMin.checked;
    dom.heightInputMax.disabled = dom.heightSliderMax.disabled = !dom.heightCheckMax.checked;
}

function filterImages() {
    const minW = dom.widthCheckMin.checked ? (parseInt(dom.widthInputMin.value, 10) || 0) : 0;
    const maxW = dom.widthCheckMax.checked ? (parseInt(dom.widthInputMax.value, 10) || 99999) : 99999;
    const minH = dom.heightCheckMin.checked ? (parseInt(dom.heightInputMin.value, 10) || 0) : 0;
    const maxH = dom.heightCheckMax.checked ? (parseInt(dom.heightInputMax.value, 10) || 99999) : 99999;
    let changed = false;
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (img.filtered) continue;
        if (img.width !== undefined && img.height !== undefined) {
            const shouldHide = img.width < minW || img.width > maxW || img.height < minH || img.height > maxH;
            if (img.sizeFiltered !== shouldHide) {
                img.sizeFiltered = shouldHide; changed = true;
                const item = document.getElementById("item-" + img.uid);
                if (item) item.style.display = shouldHide ? 'none' : '';
            }
        }
    }
    if (changed) debounceUpdateUI();
}

function handleSliderInput(e) {
    const isW = e.target.id.includes("width");
    const [minS, maxS, minI, maxI] = isW ?
        [dom.widthSliderMin, dom.widthSliderMax, dom.widthInputMin, dom.widthInputMax] :
        [dom.heightSliderMin, dom.heightSliderMax, dom.heightInputMin, dom.heightInputMax];
    let minVal = parseInt(minS.value, 10), maxVal = parseInt(maxS.value, 10);
    if (minVal > maxVal) {
        if (e.target === minS) { minS.value = maxVal; minVal = maxVal; }
        else { maxS.value = minVal; maxVal = minVal; }
    }
    minI.value = minVal; maxI.value = maxVal;
    updateSliderTrack(isW ? dom.widthTrack : dom.heightTrack, minS, maxS);
    filterImages();
}

function handleManualInput(e) {
    const isW = e.target.id.includes("width");
    const [minS, maxS] = isW ? [dom.widthSliderMin, dom.widthSliderMax] : [dom.heightSliderMin, dom.heightSliderMax];
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;
    if (e.target.id.includes("Min")) minS.value = Math.min(val, parseInt(maxS.value, 10));
    else maxS.value = Math.max(val, parseInt(minS.value, 10));
    updateSliderTrack(isW ? dom.widthTrack : dom.heightTrack, minS, maxS);
    filterImages();
}

[dom.widthSliderMin, dom.widthSliderMax, dom.heightSliderMin, dom.heightSliderMax].forEach(el => el.addEventListener('input', handleSliderInput));
[dom.widthInputMin, dom.widthInputMax, dom.heightInputMin, dom.heightInputMax].forEach(el => el.addEventListener('input', handleManualInput));
[dom.widthCheckMin, dom.widthCheckMax, dom.heightCheckMin, dom.heightCheckMax].forEach(cb => cb.addEventListener('change', () => { updateInputStates(); filterImages(); }));

updateInputStates();
updateSliderTrack(dom.widthTrack, dom.widthSliderMin, dom.widthSliderMax);
updateSliderTrack(dom.heightTrack, dom.heightSliderMin, dom.heightSliderMax);

function getCanonicalUrl(url) {
    if (!url) return "";
    try {
        const u = new URL(url);
        if (/\.(jpg|jpeg|png|webp|gif|svg|bmp|tiff)($|\?)/i.test(u.pathname)) return u.origin + u.pathname;
        return u.href;
    } catch { return url; }
}

function extractFilename(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return "image";
    try {
        const base = decodeURIComponent(url).split('?')[0].split('#')[0];
        return (base.endsWith('/') ? base.slice(0, -1) : base).split('/').pop() || "image";
    } catch { return "image"; }
}

function extractExtension(url) {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return "zz_unknown";
    try {
        const path = new URL(url).pathname, dot = path.lastIndexOf(".");
        if (dot === -1 || dot === path.length - 1) return "zz_unknown";
        return path.substring(dot + 1).toLowerCase();
    } catch { return "zz_unknown"; }
}

async function unscrambleImageProcess(imgObj, data) {
    try {
        let loadUrl = imgObj.url, isBlobObj = false;
        if (imgObj.url.startsWith('blob:')) {
            try {
                const res = await browser.tabs.sendMessage(currentTabId, { type: "CONVERT_IMAGE", url: imgObj.url });
                if (res && res.dataUrl) loadUrl = res.dataUrl; else return imgObj.url;
            } catch { return imgObj.url; }
        } else {
            loadUrl = URL.createObjectURL(await fetch(imgObj.url).then(r => r.blob()));
            isBlobObj = true;
        }
        const img = new Image();
        return new Promise((resolve) => {
            img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = data.width; canvas.height = data.height;
                const ctx = canvas.getContext("2d");
                data.instructions.forEach(op => ctx.drawImage(img, op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh));
                resolve(canvas.toDataURL("image/jpeg", 0.95));
                if (isBlobObj) URL.revokeObjectURL(loadUrl);
            };
            img.onerror = () => { if (isBlobObj) URL.revokeObjectURL(loadUrl); resolve(imgObj.url); };
            img.src = loadUrl;
        });
    } catch { return imgObj.url; }
}

async function startUnscramble(img, initialImgEl, data) {
    if (img.queuedForUnscramble || img.unscrambledUrl) return;
    img.queuedForUnscramble = true;
    const cached = await getCachedImageData(img.url);
    if (cached) {
        img.unscrambledUrl = cached; img.displayUrl = cached;
        if (initialImgEl) initialImgEl.src = cached;
        return;
    }
    unscrambleTotal++; updateProgress();
    unscrambleQueue.push(async () => {
        if (img.unscrambledUrl) { unscrambleDone++; updateProgress(); return; }
        const newUrl = await unscrambleImageProcess(img, data);
        img.unscrambledUrl = newUrl; img.displayUrl = newUrl;
        await cacheImageData(img.url, newUrl);
        unscrambleDone++; updateProgress();
        if (initialImgEl) initialImgEl.src = newUrl;
    });
}

function render() {
    dom.grid.innerHTML = "";
    renderQueue = [...images];
    requestAnimationFrame(processRenderQueue);
    debounceUpdateUI();
}

function performSort() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < images.length; i++) {
        const item = document.getElementById("item-" + images[i].uid);
        if (item) fragment.appendChild(item);
    }
    dom.grid.appendChild(fragment);
    debounceUpdateUI();
}

function processRenderQueue() {
    if (renderQueue.length === 0) return;
    const fragment = document.createDocumentFragment();
    const batch = renderQueue.splice(0, 60);
    const minW = dom.widthCheckMin.checked ? (parseInt(dom.widthInputMin.value, 10) || 0) : 0;
    const maxW = dom.widthCheckMax.checked ? (parseInt(dom.widthInputMax.value, 10) || 99999) : 99999;
    const minH = dom.heightCheckMin.checked ? (parseInt(dom.heightInputMin.value, 10) || 0) : 0;
    const maxH = dom.heightCheckMax.checked ? (parseInt(dom.heightInputMax.value, 10) || 99999) : 99999;

    for (let i = 0; i < batch.length; i++) {
        const img = batch[i];
        if (img.filtered) continue;
        if (!img.uid) img.uid = ++uidCounter;

        const item = document.createElement("div");
        item.className = "item" + (img.selected ? ' selected' : '');
        item.id = "item-" + img.uid;
        item.dataset.uid = img.uid;
        if (img.sizeFiltered) item.style.display = 'none';

        const imgEl = document.createElement("img");
        imgEl.decoding = "async";

        let scrambledData = unscrambleMap[img.url];
        if (!scrambledData) {
            const canonical = getCanonicalUrl(img.url);
            scrambledData = unscrambleMap[canonical] || unscrambleMap[img.url.split('?')[0]] || unscrambleMap[decodeURIComponent(img.url)];
        }

        if (scrambledData && scrambledData.instructions.length > 0) {
            if (img.unscrambledUrl) { imgEl.src = img.unscrambledUrl; img.displayUrl = img.unscrambledUrl; }
            else { imgEl.src = PLACEHOLDER_SVG; startUnscramble(img, imgEl, scrambledData); }
        } else if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) {
            imgEl.src = PLACEHOLDER_SVG;
            handleImageError(img, item, imgEl);
        } else {
            imgEl.src = img.displayUrl || img.url;
        }

        imgEl.onload = function() {
            if (this.src === PLACEHOLDER_SVG) return;
            const w = this.naturalWidth, h = this.naturalHeight;
            img.width = w; img.height = h;
            if (w > 0 && h > 0 && w < MIN_SIZE && h < MIN_SIZE) {
                img.filtered = true;
                if (item.parentNode) item.parentNode.removeChild(item);
                debounceUpdateUI(); return;
            }
            if (w < minW || w > maxW || h < minH || h > maxH) {
                if (!img.sizeFiltered) { img.sizeFiltered = true; item.style.display = 'none'; debounceUpdateUI(); }
            } else if (img.sizeFiltered) {
                img.sizeFiltered = false; item.style.display = ''; debounceUpdateUI();
            }
            imgEl.classList.add('loaded');
            if (w) img.pixelCount = w * h;
            if (w > 0 && h > 0) {
                const dimLabel = document.createElement('div');
                dimLabel.className = 'dim-label'; dimLabel.textContent = w + "x" + h;
                item.appendChild(dimLabel);
            }
            if (!img.filtered && !img.sizeFiltered) queueForHashing(img, item);
        };
        imgEl.onerror = () => handleImageError(img, item, imgEl);
        item.appendChild(imgEl);
        fragment.appendChild(item);
    }
    dom.grid.appendChild(fragment);

    if (targetScrollPosition > 0 && dom.gridContainer.scrollHeight >= targetScrollPosition + dom.gridContainer.clientHeight) {
        dom.gridContainer.scrollTop = targetScrollPosition; targetScrollPosition = 0;
    }
    if (renderQueue.length > 0) requestAnimationFrame(processRenderQueue);
}

function createImageIdentifier(url) {
    try {
        const u = new URL(url);
        return (/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(u.pathname) ? u.origin + u.pathname : u.href) + "::" + extractFilename(url);
    } catch { return url + "::" + extractFilename(url); }
}

async function handleImageError(img, itemEl, imgEl) {
    let stage = parseInt(imgEl.dataset.retryStage || "0", 10);
    if (stage >= 2) { if (itemEl) { itemEl.style.opacity = '0.5'; itemEl.style.pointerEvents = 'none'; } return; }
    if (stage === 0) {
        const cached = await getCachedImageData(img.url);
        if (cached) { img.displayUrl = cached; if (imgEl) imgEl.src = cached; return; }
    }
    fetchQueue.push(async () => {
        let currentStage = parseInt(imgEl.dataset.retryStage || "0", 10);
        if (currentStage >= 2) return;
        if (img.url.startsWith('blob:') && currentStage === 0) currentStage = 1;
        currentStage++; imgEl.dataset.retryStage = currentStage;
        try {
            const msgType = currentStage === 1 ? "FETCH_IMAGE_BLOB" : "CONVERT_IMAGE";
            const target = currentStage === 1 ? browser.runtime : browser.tabs;
            const res = await target.sendMessage(currentTabId, { type: msgType, url: img.url, tabId: currentTabId });
            if (res && res.dataUrl && res.dataUrl.startsWith('data:')) {
                img.displayUrl = res.dataUrl;
                if (imgEl) imgEl.src = res.dataUrl;
                await cacheImageData(img.url, res.dataUrl);
                saveState(); return;
            }
        } catch {}
        if (currentStage === 1) handleImageError(img, itemEl, imgEl);
    });
}

async function convertEssentialImages() {
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) {
            const item = document.getElementById("item-" + img.uid);
            if (item) handleImageError(img, item, item.querySelector('img'));
        }
    }
}

async function setNetworkMode(mode) {
    if (currentTabId) await browser.runtime.sendMessage({ type: "SET_NETWORK_MODE", tabId: currentTabId, networkMode: mode }).catch(() => {});
}

async function checkTabOrUrlChange() {
    if (!currentTabId) return false;
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        return tab && (tab.id !== currentTabId || tab.url !== currentTabUrl);
    } catch { return false; }
}

async function fetchUnscrambleMap() {
    try { const res = await browser.tabs.sendMessage(currentTabId, { type: "GET_UNSCRAMBLE_DATA" }); if (res && res.map) unscrambleMap = res.map; } catch {}
}

async function checkDownloadStatus() {
    try {
        const status = await browser.runtime.sendMessage({ type: "GET_DOWNLOAD_STATUS" });
        if (status && status.active) {
            isDownloading = true;
            if (status.type === 'zip') {
                dom.zipBtn.textContent = "Stop"; dom.zipBtn.classList.add('danger'); dom.downloadBtn.disabled = true;
                dom.status.textContent = status.currentIndex >= status.items.length ? "Compressing..." : ("Adding " + (status.currentIndex + 1) + "/" + status.items.length + "...");
            } else {
                dom.downloadBtn.textContent = "Stop"; dom.downloadBtn.classList.add('danger'); dom.zipBtn.disabled = true;
                dom.status.textContent = "Downloading " + (status.currentIndex + 1) + "/" + status.items.length + "...";
            }
        }
    } catch {}
}

// Registered once at top level — not inside init() — prevents duplicate listeners on mode switch
browser.runtime.onMessage.addListener(function(msg) {
    if (msg.type === "CANVAS_MAP_PUSH" && msg.map) {
        Object.assign(unscrambleMap, msg.map);
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!img.unscrambledUrl && !img.queuedForUnscramble) {
                const canonical = getCanonicalUrl(img.url);
                const data = unscrambleMap[img.url] || unscrambleMap[canonical] || unscrambleMap[img.url.split('?')[0]] || unscrambleMap[decodeURIComponent(img.url)];
                if (data) {
                    const item = document.getElementById("item-" + img.uid);
                    if (item) startUnscramble(img, item.querySelector('img'), data);
                }
            }
        }
    }
    if (msg.type === "DOWNLOAD_PROGRESS") {
        if (msg.active) {
            isDownloading = true;
            if (msg.dlType === 'zip') {
                dom.zipBtn.textContent = "Stop"; dom.zipBtn.classList.add('danger'); dom.downloadBtn.disabled = true;
                dom.status.textContent = msg.status || ("Adding " + (msg.current + 1) + "/" + msg.total + "...");
            } else {
                dom.downloadBtn.textContent = "Stop"; dom.downloadBtn.classList.add('danger'); dom.zipBtn.disabled = true;
                dom.status.textContent = msg.status || ("Downloading " + (msg.current + 1) + "/" + msg.total + "...");
            }
        } else {
            isDownloading = false;
            dom.downloadBtn.textContent = "Download"; dom.downloadBtn.classList.remove('danger');
            dom.zipBtn.textContent = "ZIP"; dom.zipBtn.classList.remove('danger');
            dom.status.textContent = msg.status || "Ready";
            dom.downloadBtn.disabled = false; dom.zipBtn.disabled = false;
        }
    }
});

async function init() {
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        currentTabId = tab.id; currentTabUrl = tab.url; if (tab.title) pageTitle = tab.title;

        try {
            const localData = await new Promise(resolve => chrome.storage.local.get(['networkMode'], resolve));
            if (localData && localData.networkMode) { fetchMode = localData.networkMode; updateNetworkModeUI(); }

            const saved = await browser.runtime.sendMessage({ type: "GET_STATE", tabId: currentTabId });
            if (saved && saved.state && saved.state.networkMode !== undefined) { fetchMode = saved.state.networkMode; updateNetworkModeUI(); }

            const urlChanged = saved && saved.state && saved.state.tabUrl && saved.state.tabUrl !== currentTabUrl;
            if (urlChanged) {
                clearAllCache(); await clearAllLocalCache();
                await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId }).catch(() => {});
            } else if (saved && saved.state && saved.state.images && saved.state.images.length) {
                images = saved.state.images;
                let maxUid = 0;
                for (let i = 0; i < images.length; i++) {
                    const imgObj = images[i];
                    if (!imgObj.uid) imgObj.uid = ++uidCounter;
                    else if (imgObj.uid > maxUid) maxUid = imgObj.uid;
                    if (!imgObj.unscrambledUrl) imgObj.queuedForUnscramble = false;
                    if (imgObj.sha256 && !imgObj.filtered && !imgObj.hashFiltered) {
                        if (contentHashes.has(imgObj.sha256)) { imgObj.filtered = true; imgObj.hashFiltered = true; imgObj.selected = false; }
                        else { contentHashes.add(imgObj.sha256); imgObj.isFirstHashInstance = true; imgObj.hashChecked = true; }
                    } else imgObj.hashChecked = false;
                }
                uidCounter = Math.max(uidCounter, maxUid);
                images.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
                pageTitle = saved.state.pageTitle; targetScrollPosition = saved.state.scrollPosition || 0;
                checkDownloadStatus();
                await fetchUnscrambleMap();
                render(); return;
            }
        } catch {}

        dom.status.textContent = "Scanning...";
        await fetchUnscrambleMap();

        if (fetchMode === 'network') {
            const netRes = await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(() => ({}));
            addFoundImages(netRes && netRes.images ? netRes.images : []);
        } else if (fetchMode === 'blob') {
            const blobRes = await browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(() => ({}));
            addFoundImages(blobRes && blobRes.urls ? blobRes.urls : []);
        } else {
            const [p, c, n, b] = await Promise.all([
                browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(() => ({})),
                browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS" }).catch(() => ({})),
                browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(() => ({})),
                browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(() => ({}))
            ]);
            if (p && p.title) pageTitle = p.title;
            const pItems = p && p.items ? p.items : (p && p.urls ? p.urls.map(u => ({ url: u })) : []);
            const cItems = c && c.urls ? c.urls.map(u => ({ url: u })) : [];
            const nItems = n && n.images ? n.images.map(u => ({ url: u })) : [];
            const bItems = b && b.urls ? b.urls.map(u => ({ url: u })) : [];
            addFoundImages([...pItems, ...cItems, ...nItems, ...bItems]);
        }
        checkDownloadStatus();
    } catch { dom.status.textContent = "Refresh page needed"; }
}
init().then(startAutoReload);

function updateUI(shouldSave) {
    let validCount = 0, selCount = 0;
    for (let i = 0; i < images.length; i++) {
        if (!images[i].filtered && !images[i].sizeFiltered) {
            validCount++;
            if (images[i].selected) selCount++;
        }
    }
    dom.tracker.textContent = validCount === 0 ? "No images" : (selCount + " / " + validCount);
    dom.toggleBtn.textContent = selCount < validCount ? "Select All" : "Deselect All";
    if (!isDownloading) dom.downloadBtn.disabled = dom.zipBtn.disabled = selCount === 0;
    if (shouldSave !== false) saveState();
}

function updateNetworkModeUI() {
    dom.networkToggle.classList.remove('network-active', 'blob-active');
    dom.modeDefault.checked = false; dom.modeNetwork.checked = false; dom.modeBlob.checked = false;
    if (fetchMode === 'network') {
        dom.networkToggle.textContent = "Network"; dom.networkToggle.classList.add('network-active'); dom.modeNetwork.checked = true;
    } else if (fetchMode === 'blob') {
        dom.networkToggle.textContent = "Scrapper"; dom.networkToggle.classList.add('blob-active'); dom.modeBlob.checked = true;
    } else {
        dom.networkToggle.textContent = "Default"; dom.modeDefault.checked = true;
    }
}

dom.grid.addEventListener('click', function(e) {
    const item = e.target.closest('.item');
    if (!item) return;
    const uid = parseInt(item.dataset.uid, 10);
    const img = images.find(i => i.uid === uid);
    if (img) { img.selected = !img.selected; item.classList.toggle('selected', img.selected); debounceUpdateUI(); saveState(); }
});

dom.toggleBtn.onclick = function() {
    let hasUnselected = false;
    for (let i = 0; i < images.length; i++) {
        if (!images[i].filtered && !images[i].sizeFiltered && !images[i].selected) { hasUnselected = true; break; }
    }
    const targetState = hasUnselected;
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img.filtered && !img.sizeFiltered) {
            img.selected = targetState;
            const item = document.getElementById("item-" + img.uid);
            if (item) item.classList.toggle('selected', targetState);
        }
    }
    updateUI(true);
};

dom.renameToggle.onclick = function() {
    renameMode = !renameMode;
    dom.renameToggle.textContent = renameMode ? "Rename" : "Original";
    dom.renameToggle.classList.toggle('original-mode', !renameMode);
};

async function switchMode(newMode) {
    if (fetchMode === newMode) return;
    clearAllCache();
    await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId }).catch(() => {});
    render(); fetchMode = newMode; updateNetworkModeUI();
    await setNetworkMode(fetchMode);
    saveState(true);
    await init();
}

dom.modeDefault.onclick = () => switchMode('default');
dom.modeNetwork.onclick = () => switchMode('network');
dom.modeBlob.onclick = () => switchMode('blob');

dom.sortBtn.onclick = function() {
    if (!sortOrder) { sortOrder = 'reverse'; dom.sortBtn.textContent = "Reverse"; }
    else if (sortOrder === 'reverse') { sortOrder = 'name'; dom.sortBtn.textContent = "Name"; }
    else if (sortOrder === 'name') { sortOrder = 'asc'; dom.sortBtn.textContent = "Asc \u2193"; }
    else if (sortOrder === 'asc') { sortOrder = 'desc'; dom.sortBtn.textContent = "Dsc \u2191"; }
    else { sortOrder = null; dom.sortBtn.textContent = "Sort \u21C5"; }

    setTimeout(function() {
        if (sortOrder === 'reverse') images.sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0));
        else if (sortOrder === 'name') {
            images.sort((a, b) => {
                const getBase = n => { const d = n.lastIndexOf('.'); return d !== -1 ? n.substring(0, d) : n; };
                const baseA = getBase(a._name), baseB = getBase(b._name);
                const numA = parseInt((baseA.match(/\d+$/) || ['0'])[0], 10);
                const numB = parseInt((baseB.match(/\d+$/) || ['0'])[0], 10);
                if (numA && numB && numA !== numB) return numA - numB;
                return a._name.localeCompare(b._name);
            });
        } else if (sortOrder === 'asc') {
            images.sort((a, b) => { const d = (a.pixelCount || 0) - (b.pixelCount || 0); return d !== 0 ? d : (a.sortOrder || 0) - (b.sortOrder || 0); });
        } else if (sortOrder === 'desc') {
            images.sort((a, b) => { const d = (b.pixelCount || 0) - (a.pixelCount || 0); return d !== 0 ? d : (a.sortOrder || 0) - (b.sortOrder || 0); });
        } else images.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        performSort();
    }, 10);
};

dom.clearCache.onclick = async function() {
    if (window.confirm("Clear all cached images for this tab?")) {
        clearAllCache(); await clearAllLocalCache();
        await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
        render(); saveState(true);
        dom.status.textContent = "Scanning...";
        await init();
    }
};

function addFoundImages(items) {
    const currentIds = new Set(images.map(i => createImageIdentifier(i.url)));
    let added = 0;
    // Safe O(n) max — avoids Math.max(...array) spread which blows the call stack on large arrays
    let startOrder = 0;
    for (let i = 0; i < images.length; i++) {
        const so = images[i].sortOrder || 0;
        if (so > startOrder) startOrder = so;
    }
    if (images.length > 0) startOrder++;

    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        let url, w, h;
        if (typeof item === 'string') { url = item; }
        else { url = item.url; w = item.w; h = item.h; }
        if (w > 0 && h > 0 && w < MIN_SIZE && h < MIN_SIZE) continue;
        const id = createImageIdentifier(url);
        if (!currentIds.has(id)) {
            images.push({
                url, displayUrl: url, selected: true,
                originalIndex: images.length + 1, sortOrder: startOrder + idx,
                uid: ++uidCounter, _name: extractFilename(url), _ext: extractExtension(url), width: w, height: h
            });
            currentIds.add(id); added++;
        }
    }

    if (added > 0) {
        render(); saveState(); convertEssentialImages();
        if (!isDownloading) { dom.status.textContent = "Scan done"; setTimeout(function() { if (dom.status.textContent === "Scan done") dom.status.textContent = "Ready"; }, 2000); }
    } else if (images.length === 0 && !isDownloading) {
        render(); dom.status.textContent = "No images found";
    }
}

async function startAutoReload() {
    var loop = async function() {
        if (!currentTabId) return;
        if (await checkTabOrUrlChange()) {
            clearAllCache(); await clearAllLocalCache();
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (tab) { currentTabId = tab.id; currentTabUrl = tab.url; }
            await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId }).catch(() => {});
            await init(); setTimeout(loop, 3500); return;
        }
        try {
            await fetchUnscrambleMap();
            if (fetchMode === 'network') {
                const netRes = await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(() => ({}));
                addFoundImages(netRes && netRes.images ? netRes.images.map(u => ({ url: u })) : []);
            } else if (fetchMode === 'blob') {
                const blobRes = await browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(() => ({}));
                addFoundImages(blobRes && blobRes.urls ? blobRes.urls.map(u => ({ url: u })) : []);
            } else {
                const [p, c, n, b] = await Promise.all([
                    browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(() => ({})),
                    browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS" }).catch(() => ({})),
                    browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(() => ({})),
                    browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(() => ({}))
                ]);
                const pItems = p && p.items ? p.items : (p && p.urls ? p.urls.map(u => ({ url: u })) : []);
                const cItems = c && c.urls ? c.urls.map(u => ({ url: u })) : [];
                const nItems = n && n.images ? n.images.map(u => ({ url: u })) : [];
                const bItems = b && b.urls ? b.urls.map(u => ({ url: u })) : [];
                addFoundImages([...pItems, ...cItems, ...nItems, ...bItems]);
            }
        } catch {}
        setTimeout(loop, 3500);
    };
    loop();
}

async function getBlobForDownload(img) {
    if (img.displayUrl && img.displayUrl.startsWith('blob:')) try { return await fetch(img.displayUrl).then(r => r.blob()); } catch {}
    if (img.displayUrl && img.displayUrl.startsWith('data:')) return dataURItoBlob(img.displayUrl);
    try { return await fetch(img.url).then(r => r.blob()); }
    catch {
        try {
            const res = await browser.tabs.sendMessage(currentTabId, { type: "CONVERT_IMAGE", url: img.url });
            return res && res.dataUrl ? dataURItoBlob(res.dataUrl) : null;
        } catch { return null; }
    }
}

dom.downloadBtn.onclick = async function() {
    if (isDownloading) {
        await browser.runtime.sendMessage({ type: "STOP_DOWNLOAD" });
        isDownloading = false;
        dom.downloadBtn.textContent = "Download"; dom.downloadBtn.classList.remove('danger');
        dom.status.textContent = "Stopped"; dom.zipBtn.disabled = false;
        return;
    }
    const valid = images.filter(i => i.selected && !i.filtered && !i.sizeFiltered);
    if (!valid.length) return;
    isDownloading = true;
    dom.downloadBtn.textContent = "Stop"; dom.downloadBtn.classList.add('danger'); dom.zipBtn.disabled = true;

    const folder = (dom.folderName.value.trim().replace(/\/$/, "") || "").replace(/[^a-z0-9_-]/gi, "_").substring(0, 50);
    const list = sortOrder ? valid.slice() : valid.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    // Precompute index map: O(n) instead of O(n²) images.indexOf inside loop
    const indexMap = new Map();
    for (let i = 0; i < images.length; i++) indexMap.set(images[i].uid, i + 1);

    const payloadItems = list.map(function(img) {
        let fname;
        if (renameMode) {
            fname = (folder ? folder + '/' : '') + "image" + String(indexMap.get(img.uid)).padStart(3, '0') + ".jpg";
            if (isAndroid) fname = fname.replace('/', '_');
        } else {
            let oname = img._name;
            if (!oname.includes('.')) oname += ".jpg";
            fname = (folder ? folder + (isAndroid ? '_' : '/') : '') + oname;
        }
        return { url: img.url, displayUrl: img.displayUrl, filename: fname };
    });

    await browser.runtime.sendMessage({ type: "START_DOWNLOAD", items: payloadItems, tabId: currentTabId, isAndroid: isAndroid, dlType: 'single' });
};

dom.zipBtn.onclick = async function() {
    if (isDownloading) {
        await browser.runtime.sendMessage({ type: "STOP_DOWNLOAD" });
        isDownloading = false;
        dom.zipBtn.textContent = "ZIP"; dom.zipBtn.classList.remove('danger');
        dom.status.textContent = "Stopped"; dom.downloadBtn.disabled = false;
        return;
    }
    const valid = images.filter(i => i.selected && !i.filtered && !i.sizeFiltered);
    if (!valid.length) return;
    isDownloading = true;
    dom.zipBtn.textContent = "Stop"; dom.zipBtn.classList.add('danger'); dom.downloadBtn.disabled = true;
    dom.status.textContent = "Preparing ZIP...";

    const list = sortOrder ? valid.slice() : valid.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const used = new Set();
    // Precompute index map: O(n) instead of O(n²) images.indexOf inside loop
    const indexMap = new Map();
    for (let i = 0; i < images.length; i++) indexMap.set(images[i].uid, i + 1);

    const payloadItems = list.map(function(img) {
        let fname;
        if (renameMode) {
            fname = "image_" + String(indexMap.get(img.uid)).padStart(3, '0') + ".jpg";
        } else {
            let oname = img._name; if (!oname.includes('.')) oname += ".jpg";
            let final = oname, c = 1;
            while (used.has(final)) {
                const pt = oname.lastIndexOf('.');
                final = pt !== -1 ? oname.substring(0, pt) + "(" + c + ")" + oname.substring(pt) : oname + "(" + c + ")";
                c++;
            }
            used.add(final); fname = final;
        }
        return { url: img.url, displayUrl: img.displayUrl, filename: fname };
    });

    let cleanTitle = pageTitle.replace(/[<>:"/\\|?*]/g, "").replace(/[\x00-\x1f]/g, "").trim();
    if (!cleanTitle) cleanTitle = "images";
    await browser.runtime.sendMessage({ type: "START_DOWNLOAD", items: payloadItems, tabId: currentTabId, isAndroid: isAndroid, dlType: 'zip', zipFilename: cleanTitle + ".zip" });
};

function dataURItoBlob(dataURI) {
    try {
        const split = dataURI.split(','), bytes = atob(split[1]);
        const ia = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) ia[i] = bytes.charCodeAt(i);
        return new Blob([ia], { type: split[0].split(':')[1].split(';')[0] });
    } catch { return null; }
}

updateNetworkModeUI();
dom.settingsBtn.onclick = () => dom.settingsPanel.classList.remove('hidden');
dom.closeSettings.onclick = () => dom.settingsPanel.classList.add('hidden');
