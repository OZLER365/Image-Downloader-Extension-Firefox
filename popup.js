const isAndroid = /Android/i.test(navigator.userAgent);
if (isAndroid) document.documentElement.classList.add("android");

const MIN_SIZE = 50;
const PLACEHOLDER_SVG = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBmaWxsPSIjZWRlZGVkIiBkPSJNMCAwaDI0djI0SDB6Ii8+PC9zdmc+";

let images = [], currentTabId = null, currentTabUrl = null, pageTitle = "images";
let renameMode = true, fetchMode = 'default', saveTimeout = null;
let renderQueue = [], targetScrollPosition = 0, sortOrder = null, uidCounter = 0;
let unscrambleMap = {}, unscrambleTotal = 0, unscrambleDone = 0;

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
    refreshBtn: document.getElementById("refreshBtn"),
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
    uiUpdateTimer = requestAnimationFrame(() => {
        updateUI(false);
        uiUpdateTimer = null;
    });
}

class AsyncQueue {
    constructor(concurrency) { this.concurrency = concurrency; this.running = 0; this.queue = []; }
    push(task) { this.queue.push(task); this.next(); }
    next() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            this.running++;
            task().finally(() => { this.running--; this.next(); });
        }
    }
}
const fetchQueue = new AsyncQueue(4);
const unscrambleQueue = new AsyncQueue(1);

function updateProgress() {
    if (unscrambleTotal > 0) {
        dom.status.textContent = `Descrambling ${unscrambleDone}/${unscrambleTotal}...`;
        if (unscrambleDone >= unscrambleTotal) setTimeout(() => { if (unscrambleDone >= unscrambleTotal) { dom.status.textContent = "Ready"; unscrambleTotal = 0; unscrambleDone = 0; } }, 1500);
    }
}

function saveState(immediate = false) {
    clearTimeout(saveTimeout);
    const doSave = () => {
        if (!currentTabId) return;
        idleCallback(() => {
            // Optimization: Avoid serializing heavy data if not needed, but we must preserve state.
            browser.runtime.sendMessage({
                type: "SAVE_STATE", tabId: currentTabId,
                state: { images, pageTitle, scrollPosition: dom.gridContainer.scrollTop, networkMode: fetchMode, tabUrl: currentTabUrl }
            }).catch(() => {});
        }, { timeout: 2000 });
    };
    if (immediate) doSave(); else saveTimeout = setTimeout(doSave, 1500);
}
window.addEventListener("pagehide", () => saveState(true));
window.addEventListener("blur", () => saveState(true));

function clearAllCache() { images = []; uidCounter = 0; unscrambleTotal = 0; unscrambleDone = 0; }

function updateSliderTrack(track, minInput, maxInput) {
    const min = parseInt(minInput.min), max = parseInt(minInput.max);
    const vMin = parseInt(minInput.value), vMax = parseInt(maxInput.value);
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
    const minW = dom.widthCheckMin.checked ? (parseInt(dom.widthInputMin.value) || 0) : 0;
    const maxW = dom.widthCheckMax.checked ? (parseInt(dom.widthInputMax.value) || 99999) : 99999;
    const minH = dom.heightCheckMin.checked ? (parseInt(dom.heightInputMin.value) || 0) : 0;
    const maxH = dom.heightCheckMax.checked ? (parseInt(dom.heightInputMax.value) || 99999) : 99999;
    
    let changed = false;
    for (const img of images) {
        if (img.filtered) continue;
        if (img.width !== undefined && img.height !== undefined) {
            const shouldHide = img.width < minW || img.width > maxW || img.height < minH || img.height > maxH;
            if (img.sizeFiltered !== shouldHide) {
                img.sizeFiltered = shouldHide; changed = true;
                const item = document.getElementById(`item-${img.uid}`);
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
    
    let minVal = parseInt(minS.value), maxVal = parseInt(maxS.value);
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
    let val = parseInt(e.target.value);
    if (isNaN(val)) return;
    if (e.target.id.includes("Min")) minS.value = Math.min(val, parseInt(maxS.value));
    else maxS.value = Math.max(val, parseInt(minS.value));
    updateSliderTrack(isW ? dom.widthTrack : dom.heightTrack, minS, maxS);
    filterImages();
}

[dom.widthSliderMin, dom.widthSliderMax, dom.heightSliderMin, dom.heightSliderMax].forEach(el => el.addEventListener('input', handleSliderInput));
[dom.widthInputMin, dom.widthInputMax, dom.heightInputMin, dom.heightInputMax].forEach(el => el.addEventListener('input', handleManualInput));
[dom.widthCheckMin, dom.widthCheckMax, dom.heightCheckMin, dom.heightCheckMax].forEach(cb => { cb.addEventListener('change', () => { updateInputStates(); filterImages(); }); });

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
        const name = (base.endsWith('/') ? base.slice(0, -1) : base).split('/').pop();
        return name || "image";
    } catch { return "image"; }
}

function extractExtension(url) {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return "zz_unknown";
    try {
        const path = new URL(url).pathname;
        const dot = path.lastIndexOf(".");
        if (dot === -1 || dot === path.length - 1) return "zz_unknown";
        return path.substring(dot + 1).toLowerCase();
    } catch { return "zz_unknown"; }
}

async function unscrambleImageProcess(imgObj, data) {
    try {
        let loadUrl = imgObj.url;
        let isBlobObj = false;
        if (imgObj.url.startsWith('blob:')) {
            try {
                const res = await browser.tabs.sendMessage(currentTabId, { type: "CONVERT_IMAGE", url: imgObj.url });
                if (res && res.dataUrl) loadUrl = res.dataUrl;
                else return imgObj.url;
            } catch { return imgObj.url; }
        } else {
            const blob = await fetch(imgObj.url).then(r => r.blob());
            loadUrl = URL.createObjectURL(blob);
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

function startUnscramble(img, initialImgEl, data) {
    if (img.queuedForUnscramble || img.unscrambledUrl) return;
    img.queuedForUnscramble = true;
    unscrambleTotal++;
    updateProgress();
    unscrambleQueue.push(async () => {
        if (img.unscrambledUrl) { unscrambleDone++; updateProgress(); return; }
        const newUrl = await unscrambleImageProcess(img, data);
        img.unscrambledUrl = newUrl;
        img.displayUrl = newUrl;
        unscrambleDone++;
        updateProgress();
        const item = document.getElementById(`item-${img.uid}`);
        if (item) { const currentImg = item.querySelector('img'); if (currentImg) currentImg.src = newUrl; }
        else if (initialImgEl && initialImgEl.isConnected) initialImgEl.src = newUrl;
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
    for (const img of images) {
        const item = document.getElementById(`item-${img.uid}`);
        if (item) fragment.appendChild(item);
    }
    dom.grid.appendChild(fragment);
    debounceUpdateUI();
}

function processRenderQueue() {
    if (renderQueue.length === 0) return;
    const fragment = document.createDocumentFragment();
    const batch = renderQueue.splice(0, 60);
    const minW = dom.widthCheckMin.checked ? (parseInt(dom.widthInputMin.value) || 0) : 0;
    const maxW = dom.widthCheckMax.checked ? (parseInt(dom.widthInputMax.value) || 99999) : 99999;
    const minH = dom.heightCheckMin.checked ? (parseInt(dom.heightInputMin.value) || 0) : 0;
    const maxH = dom.heightCheckMax.checked ? (parseInt(dom.heightInputMax.value) || 99999) : 99999;

    for (const img of batch) {
        if (img.filtered) continue;
        if (!img.uid) img.uid = ++uidCounter;

        const item = document.createElement("div");
        item.className = `item ${img.selected ? 'selected' : ''}`;
        item.id = `item-${img.uid}`;
        item.dataset.uid = img.uid;
        if (img.sizeFiltered) item.style.display = 'none';

        const imgEl = document.createElement("img");
        imgEl.decoding = "async";
        
        let scrambledData = null;
        if (unscrambleMap[img.url]) scrambledData = unscrambleMap[img.url];
        else {
            const canonical = getCanonicalUrl(img.url);
            scrambledData = unscrambleMap[canonical] || unscrambleMap[img.url.split('?')[0]] || unscrambleMap[decodeURIComponent(img.url)];
        }

        if (scrambledData && scrambledData.instructions.length > 0) {
            if (img.unscrambledUrl) { imgEl.src = img.unscrambledUrl; img.displayUrl = img.unscrambledUrl; }
            else { imgEl.src = img.url; startUnscramble(img, imgEl, scrambledData); }
        } else if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) {
            imgEl.src = PLACEHOLDER_SVG;
            fetchQueue.push(() => handleImageError(img, item, imgEl));
        } else imgEl.src = img.displayUrl || img.url;

        imgEl.onload = function() {
            if (this.src === PLACEHOLDER_SVG) return;
            const w = this.naturalWidth, h = this.naturalHeight;
            img.width = w; img.height = h;
            
            if (w > 0 && h > 0 && w < MIN_SIZE && h < MIN_SIZE) {
                img.filtered = true;
                if (item.parentNode) item.parentNode.removeChild(item);
                debounceUpdateUI();
                return;
            }
            
            if (w < minW || w > maxW || h < minH || h > maxH) {
                if (!img.sizeFiltered) { img.sizeFiltered = true; item.style.display = 'none'; debounceUpdateUI(); }
            } else if (img.sizeFiltered) {
                img.sizeFiltered = false; item.style.display = ''; debounceUpdateUI();
            }
            if (this.src !== PLACEHOLDER_SVG) imgEl.classList.add('loaded');
            if (w) img.pixelCount = w * h;
            if (w > 0 && h > 0) {
                const dimLabel = document.createElement('div');
                dimLabel.className = 'dim-label'; dimLabel.textContent = `${w}x${h}`;
                item.appendChild(dimLabel);
            }
        };
        imgEl.onerror = () => fetchQueue.push(() => handleImageError(img, item, imgEl));
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
    let stage = parseInt(imgEl.dataset.retryStage || "0");
    if (stage >= 2) { if (itemEl) { itemEl.style.opacity = '0.5'; itemEl.style.pointerEvents = 'none'; } return; }
    if (img.url.startsWith('blob:') && stage === 0) stage = 1; 

    stage++; imgEl.dataset.retryStage = stage;
    try {
        const msgType = stage === 1 ? "FETCH_IMAGE_BLOB" : "CONVERT_IMAGE";
        const target = stage === 1 ? browser.runtime : browser.tabs;
        const res = await target.sendMessage(currentTabId, { type: msgType, url: img.url, tabId: currentTabId });
        if (res?.dataUrl && res.dataUrl.startsWith('data:')) {
            img.displayUrl = res.dataUrl; imgEl.src = res.dataUrl; saveState(); return;
        }
    } catch {}
    if(stage===1) await handleImageError(img, itemEl, imgEl);
}

async function convertEssentialImages() {
    for (const img of images) {
        if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) {
            const item = document.getElementById(`item-${img.uid}`);
            if(item) fetchQueue.push(() => handleImageError(img, item, item.querySelector('img')));
        }
    }
}

async function setNetworkMode(mode) {
    if (currentTabId) await browser.runtime.sendMessage({ type: "SET_NETWORK_MODE", tabId: currentTabId, networkMode: mode }).catch(()=>{});
}

async function checkUrlChange() {
    if (!currentTabId) return false;
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        return tab && tab.url !== currentTabUrl;
    } catch { return false; }
}

async function fetchUnscrambleMap() {
    try { const res = await browser.tabs.sendMessage(currentTabId, { type: "GET_UNSCRAMBLE_DATA" }); if (res?.map) unscrambleMap = res.map; } catch {}
}

async function init() {
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        currentTabId = tab.id; currentTabUrl = tab.url; if (tab.title) pageTitle = tab.title;
        
        browser.runtime.onMessage.addListener((msg) => {
            if (msg.type === "CANVAS_MAP_PUSH" && msg.map) {
                Object.assign(unscrambleMap, msg.map);
                for (const img of images) {
                    if (!img.unscrambledUrl && !img.queuedForUnscramble) {
                        const canonical = getCanonicalUrl(img.url);
                        const data = unscrambleMap[img.url] || unscrambleMap[canonical] || unscrambleMap[img.url.split('?')[0]] || unscrambleMap[decodeURIComponent(img.url)];
                        if (data) {
                            const item = document.getElementById(`item-${img.uid}`);
                            if (item) startUnscramble(img, item.querySelector('img'), data);
                        }
                    }
                }
            }
        });

        try {
            const saved = await browser.runtime.sendMessage({ type: "GET_STATE", tabId: currentTabId });
            if (saved?.state?.networkMode !== undefined) { fetchMode = saved.state.networkMode; updateNetworkModeUI(); await setNetworkMode(fetchMode); }
            const urlChanged = saved?.state?.tabUrl && saved.state.tabUrl !== currentTabUrl;
            if (urlChanged) {
                clearAllCache(); await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
            } else if (saved?.state) {
                if (saved.state.images?.length && !urlChanged) {
                    images = saved.state.images;
                    let maxUid = 0;
                    for(const i of images) {
                         if(!i.uid) i.uid = ++uidCounter; else if(i.uid > uidCounter) maxUid = i.uid;
                         if (!i.unscrambledUrl) i.queuedForUnscramble = false;
                    }
                    uidCounter = Math.max(uidCounter, maxUid);
                    images.sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
                    pageTitle = saved.state.pageTitle; targetScrollPosition = saved.state.scrollPosition || 0;
                    dom.status.textContent = "Restored";
                    await fetchUnscrambleMap();
                    render(); return;
                }
            }
        } catch {}
        
        await setNetworkMode(fetchMode);
        dom.status.textContent = "Scanning...";
        await fetchUnscrambleMap();

        if (fetchMode === 'network') {
            const netRes = await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}));
            addFoundImages(netRes?.images || []);
        } else if (fetchMode === 'blob') {
            const blobRes = await browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(()=>({}));
            addFoundImages(blobRes?.urls || []);
        } else {
            const [p, c, n] = await Promise.all([
                browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(()=>({})),
                browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS" }).catch(()=>({})),
                browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}))
            ]);
            if (p?.title) pageTitle = p.title;
            const pItems = p?.items || (p?.urls || []).map(u => ({url: u}));
            const cItems = (c?.urls||[]).map(u => ({url: u}));
            const nItems = (n?.images||[]).map(u => ({url: u}));
            addFoundImages([...pItems, ...cItems, ...nItems]);
        }
    } catch { dom.status.textContent = "Refresh page needed"; }
}
init().then(startAutoReload);

function updateUI(shouldSave = true) {
    const valid = images.filter(i => !i.filtered && !i.sizeFiltered);
    const sel = valid.filter(i => i.selected).length;
    dom.tracker.textContent = valid.length === 0 ? "No images" : `${sel} / ${valid.length}`;
    dom.toggleBtn.textContent = valid.some(i => !i.selected) ? "Select All" : "Deselect All";
    dom.downloadBtn.disabled = dom.zipBtn.disabled = sel === 0;
    if (shouldSave) saveState();
}

function updateNetworkModeUI() {
    dom.networkToggle.classList.remove('network-active', 'blob-active');
    dom.modeDefault.checked = false;
    dom.modeNetwork.checked = false;
    dom.modeBlob.checked = false;
    
    if (fetchMode === 'network') {
        dom.networkToggle.textContent = "Network";
        dom.networkToggle.classList.add('network-active');
        dom.modeNetwork.checked = true;
    } else if (fetchMode === 'blob') {
        dom.networkToggle.textContent = "Scrapper";
        dom.networkToggle.classList.add('blob-active');
        dom.modeBlob.checked = true;
    } else {
        dom.networkToggle.textContent = "Default";
        dom.modeDefault.checked = true;
    }
}

dom.grid.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const img = images.find(i => i.uid === parseInt(item.dataset.uid));
    if (img) { img.selected = !img.selected; item.classList.toggle('selected', img.selected); debounceUpdateUI(); saveState(); }
});

dom.toggleBtn.onclick = () => {
    const valid = images.filter(i => !i.filtered && !i.sizeFiltered);
    if (!valid.length) return;
    const target = valid.some(i => !i.selected);
    for (const i of valid) {
        i.selected = target;
        const item = document.getElementById(`item-${i.uid}`);
        if(item) item.classList.toggle('selected', target);
    }
    updateUI(true);
};

dom.renameToggle.onclick = () => {
    renameMode = !renameMode; dom.renameToggle.textContent = renameMode ? "Rename" : "Original"; dom.renameToggle.classList.toggle('original-mode', !renameMode);
};

async function switchMode(newMode) {
    if (fetchMode === newMode) return;
    images = []; 
    uidCounter = 0; 
    unscrambleTotal = 0; 
    unscrambleDone = 0;
    render();
    fetchMode = newMode;
    updateNetworkModeUI();
    await setNetworkMode(fetchMode);
    saveState(true); 
    await init();
}

dom.modeDefault.onclick = () => switchMode('default');
dom.modeNetwork.onclick = () => switchMode('network');
dom.modeBlob.onclick = () => switchMode('blob');

dom.refreshBtn.onclick = async () => {
    clearAllCache();
    await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
    saveState(true);
    dom.status.textContent = "Refreshing...";
    await init();
};

dom.sortBtn.onclick = () => {
    if (!sortOrder) { sortOrder = 'name'; dom.sortBtn.textContent = "Name"; }
    else if (sortOrder === 'name') { sortOrder = 'asc'; dom.sortBtn.textContent = "Asc ↓"; }
    else if (sortOrder === 'asc') { sortOrder = 'desc'; dom.sortBtn.textContent = "Dsc ↑"; }
    else { sortOrder = null; dom.sortBtn.textContent = "Sort ⇅"; }
    
    setTimeout(() => {
        if (sortOrder === 'name') {
            images.sort((a,b) => {
                const getBase = (n) => { const d = n.lastIndexOf('.'); return d !== -1 ? n.substring(0, d) : n; };
                const nameA = a._name, nameB = b._name;
                const baseA = getBase(nameA), baseB = getBase(nameB);
                const numA = parseInt(baseA.match(/\d+$/)?.[0] || '0'), numB = parseInt(baseB.match(/\d+$/)?.[0] || '0');
                if (numA && numB && numA !== numB) return numA - numB;
                return nameA.localeCompare(nameB);
            });
        }
        else if (sortOrder === 'asc') {
            images.sort((a,b) => {
                const diff = (a.pixelCount||0) - (b.pixelCount||0);
                return diff !== 0 ? diff : (a.sortOrder||0) - (b.sortOrder||0);
            });
        }
        else if (sortOrder === 'desc') {
            images.sort((a,b) => {
                const diff = (b.pixelCount||0) - (a.pixelCount||0);
                return diff !== 0 ? diff : (a.sortOrder||0) - (b.sortOrder||0);
            });
        }
        else images.sort((a,b) => (a.sortOrder||0) - (b.sortOrder||0));
        performSort();
    }, 10);
};

dom.clearCache.onclick = async () => {
    const confirm = window.confirm("Clear all cached images for this tab?");
    if (confirm) {
        clearAllCache();
        await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
        render(); 
        saveState(true); 
        dom.status.textContent = "Cache cleared"; 
        setTimeout(() => dom.status.textContent = "Ready", 2000); 
    }
};

function addFoundImages(items) {
    const currentIds = new Set(images.map(i => createImageIdentifier(i.url)));
    let added = 0;
    const startOrder = images.length > 0 ? Math.max(...images.map(i => i.sortOrder||0)) + 1 : 0;
    
    items.forEach((item, idx) => {
        let url, w, h;
        if (typeof item === 'string') { url = item; }
        else { url = item.url; w = item.w; h = item.h; }

        if (w > 0 && h > 0 && w < MIN_SIZE && h < MIN_SIZE) return;

        const id = createImageIdentifier(url);
        if (!currentIds.has(id)) { 
            images.push({ 
                url, displayUrl: url, selected: true, 
                originalIndex: images.length + 1, sortOrder: startOrder + idx, 
                uid: ++uidCounter,
                _name: extractFilename(url),
                _ext: extractExtension(url),
                width: w, height: h
            }); 
            currentIds.add(id); added++; 
        }
    });
    
    if (added > 0) { render(); saveState(); convertEssentialImages(); dom.status.textContent = "Scan done"; setTimeout(() => { if(dom.status.textContent === "Scan done") dom.status.textContent = "Ready"; }, 2000); }
    else if (images.length === 0) { render(); dom.status.textContent = "No images found"; }
}

async function startAutoReload() {
    const loop = async () => {
        if (!currentTabId) return;
        if (await checkUrlChange()) {
            clearAllCache(); const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            currentTabUrl = tab.url; await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
            await init(); setTimeout(loop, 3500); return;
        }
        try {
            await fetchUnscrambleMap(); 
            if (fetchMode === 'network') {
                const netRes = await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}));
                addFoundImages((netRes?.images || []).map(u=>({url:u})));
            } else if (fetchMode === 'blob') {
                const blobRes = await browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(()=>({}));
                addFoundImages((blobRes?.urls || []).map(u=>({url:u})));
            } else {
                const [p, c, n] = await Promise.all([
                    browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(()=>({})),
                    browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS" }).catch(()=>({})),
                    browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}))
                ]);
                const pItems = p?.items || (p?.urls || []).map(u => ({url: u}));
                const cItems = (c?.urls||[]).map(u => ({url: u}));
                const nItems = (n?.images||[]).map(u => ({url: u}));
                addFoundImages([...pItems, ...cItems, ...nItems]);
            }
        } catch {}
        setTimeout(loop, 3500);
    };
    loop();
}

async function getBlobForDownload(img) {
    if (img.displayUrl && img.displayUrl.startsWith('blob:')) try { return await fetch(img.displayUrl).then(r => r.blob()); } catch { }
    if (img.displayUrl && img.displayUrl.startsWith('data:')) return dataURItoBlob(img.displayUrl);
    try { return await (await fetch(img.url)).blob(); }
    catch { try { const res = await browser.tabs.sendMessage(currentTabId, { type: "CONVERT_IMAGE", url: img.url }); return res?.dataUrl ? dataURItoBlob(res.dataUrl) : null; } catch { return null; } }
}

dom.downloadBtn.onclick = async () => {
    const valid = images.filter(i => i.selected && !i.filtered && !i.sizeFiltered);
    if (!valid.length) return;
    dom.downloadBtn.disabled = true;
    const folder = (dom.folderName.value.trim().replace(/\/$/, "") || "").replace(/[^a-z0-9_-]/gi, "_").substring(0, 50);
    const list = sortOrder ? [...valid] : [...valid].sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
    try {
        for (let i = 0; i < list.length; i++) {
            if (i % 5 === 0) { dom.status.textContent = `Downloading ${i+1}/${list.length}...`; await new Promise(r => setTimeout(r, 0)); }
            const blob = await getBlobForDownload(list[i]);
            if (blob) {
                let fname;
                if (renameMode) { fname = (folder ? folder + '/' : '') + `image${String(images.indexOf(list[i])+1).padStart(3,'0')}.jpg`; if (isAndroid) fname = fname.replace('/', '_'); }
                else { let oname = list[i]._name; if (!oname.includes('.')) oname += ".jpg"; fname = (folder ? folder + (isAndroid?'_':'/') : '') + oname; }
                await triggerDownload(blob, fname); await new Promise(r => setTimeout(r, isAndroid ? 1800 : 200));
            }
        }
        dom.status.textContent = "Done!";
    } catch { dom.status.textContent = "Error"; }
    setTimeout(() => dom.status.textContent = "Ready", 2000); dom.downloadBtn.disabled = false;
};

dom.zipBtn.onclick = async () => {
    const valid = images.filter(i => i.selected && !i.filtered && !i.sizeFiltered);
    if (!valid.length) return;
    dom.zipBtn.disabled = true; dom.zipBtn.textContent = "Zipping...";
    const list = sortOrder ? [...valid] : [...valid].sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
    try {
        const zip = new JSZip(), used = new Set();
        for (let i = 0; i < list.length; i++) {
            if (i % 5 === 0) { dom.status.textContent = `Adding ${i+1}/${list.length}...`; await new Promise(r => setTimeout(r, 0)); }
            const blob = await getBlobForDownload(list[i]);
            if (blob) {
                let fname;
                if (renameMode) fname = `image_${String(images.indexOf(list[i])+1).padStart(3,'0')}.jpg`;
                else {
                    let oname = list[i]._name; if (!oname.includes('.')) oname += ".jpg";
                    let final = oname, c = 1; while(used.has(final)) { const pt = oname.lastIndexOf('.'); final = pt !== -1 ? `${oname.substring(0,pt)}(${c})${oname.substring(pt)}` : `${oname}(${c})`; c++; }
                    used.add(final); fname = final;
                }
                zip.file(fname, blob);
            }
        }
        dom.status.textContent = "Compressing..."; await new Promise(r => setTimeout(r, 0));
        const content = await zip.generateAsync({ type: "blob" });
        let cleanTitle = pageTitle.replace(/[<>:"/\\|?*]/g, "").replace(/[\x00-\x1f]/g, "").trim();
        if (!cleanTitle) cleanTitle = "images";
        await triggerDownload(content, cleanTitle + ".zip");
        dom.status.textContent = "Saved!";
    } catch { dom.status.textContent = "Failed"; }
    dom.zipBtn.disabled = false; dom.zipBtn.textContent = "ZIP"; setTimeout(() => dom.status.textContent = "Ready", 2000);
};

async function triggerDownload(blob, filename) {
    if (isAndroid) {
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.style.display = 'none'; document.body.appendChild(a); a.click();
        await new Promise(r => setTimeout(r, 500)); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 30000);
    } else {
        const url = URL.createObjectURL(blob);
        try { await browser.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }); }
        catch { const a = document.createElement('a'); a.href = url; a.download = filename.split('/').pop(); document.body.appendChild(a); a.click(); document.body.removeChild(a); }
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
}

function dataURItoBlob(dataURI) {
    try {
        const split = dataURI.split(','); const bytes = atob(split[1]);
        const ia = new Uint8Array(bytes.length); for (let i = 0; i < bytes.length; i++) ia[i] = bytes.charCodeAt(i);
        return new Blob([ia], {type: split[0].split(':')[1].split(';')[0]});
    } catch { return null; }
}

updateNetworkModeUI();
dom.settingsBtn.onclick = () => dom.settingsPanel.classList.remove('hidden');
dom.closeSettings.onclick = () => dom.settingsPanel.classList.add('hidden');
