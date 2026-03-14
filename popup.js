const isAndroid = /Android/i.test(navigator.userAgent);
if (isAndroid) document.documentElement.classList.add("android");

const MIN_SIZE = 50, PLACEHOLDER_SVG = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBmaWxsPSIjZWRlZGVkIiBkPSJNMCAwaDI0djI0SDB6Ii8+PC9zdmc+";
let images = [], currentTabId = null, currentTabUrl = null, pageTitle = "images", renameMode = true, fetchMode = 'default';
let saveTimeout = null, renderQueue = [], targetScrollPosition = 0, sortOrder = null, uidCounter = 0, unscrambleMap = {}, unscrambleTotal = 0, unscrambleDone = 0, stateLoaded = false, uiUpdateTimer = null, progressInterval = null;

const dom = {
    status: document.getElementById("status"), gridContainer: document.getElementById("grid-container"), grid: document.getElementById("grid"), toggleBtn: document.getElementById("toggleSelect"), tracker: document.getElementById("tracker-pill"), folderName: document.getElementById("folderName"), renameToggle: document.getElementById("renameToggle"), networkToggle: document.getElementById("networkToggle"), sortBtn: document.getElementById("sortBtn"), downloadBtn: document.getElementById("download"), zipBtn: document.getElementById("zip"), clearCache: document.getElementById("clearCache"), widthInputMin: document.getElementById("widthInputMin"), widthInputMax: document.getElementById("widthInputMax"), heightInputMin: document.getElementById("heightInputMin"), heightInputMax: document.getElementById("heightInputMax"), widthSliderMin: document.getElementById("widthSliderMin"), widthSliderMax: document.getElementById("widthSliderMax"), heightSliderMin: document.getElementById("heightSliderMin"), heightSliderMax: document.getElementById("heightSliderMax"), widthTrack: document.getElementById("widthTrack"), heightTrack: document.getElementById("heightTrack"), widthCheckMin: document.getElementById("widthCheckMin"), widthCheckMax: document.getElementById("widthCheckMax"), heightCheckMin: document.getElementById("heightCheckMin"), heightCheckMax: document.getElementById("heightCheckMax"), settingsBtn: document.getElementById("settingsBtn"), settingsPanel: document.getElementById("settings-panel"), closeSettings: document.getElementById("closeSettings"), modeDefault: document.getElementById("modeDefault"), modeNetwork: document.getElementById("modeNetwork"), modeBlob: document.getElementById("modeBlob")
};

function debounceUpdateUI() { if (!uiUpdateTimer) uiUpdateTimer = requestAnimationFrame(() => { updateUI(false); uiUpdateTimer = null; }); }

class AsyncQueue {
    constructor(concurrency) { this.concurrency = concurrency; this.running = 0; this.queue = []; this.onStart = null; this.onEmpty = null; }
    push(task) { if (this.running === 0 && this.queue.length === 0 && this.onStart) this.onStart(); this.queue.push(task); this.next(); }
    next() { while (this.running < this.concurrency && this.queue.length > 0) { const task = this.queue.shift(); this.running++; task().finally(() => { this.running--; this.next(); if (this.running === 0 && this.queue.length === 0 && this.onEmpty) this.onEmpty(); }); } }
}
const fetchQueue = new AsyncQueue(4), unscrambleQueue = new AsyncQueue(1), hashQueue = new AsyncQueue(4), contentHashes = new Set();
hashQueue.onStart = () => { if (dom.status.textContent === "Ready" || dom.status.textContent === "Scan done") dom.status.textContent = "Removing duplicates..."; };
hashQueue.onEmpty = () => { if (dom.status.textContent === "Removing duplicates...") dom.status.textContent = "Ready"; };

async function computeSHA256(blob) {
    try {
        const hashArray = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
        let hashHex = ''; for (let i = 0; i < hashArray.length; i++) hashHex += hashArray[i].toString(16).padStart(2, '0');
        return hashHex;
    } catch { return null; }
}

async function getBlobForDownload(img) {
    if (img.displayUrl && img.displayUrl.startsWith('blob:')) try { return await fetch(img.displayUrl).then(r => r.blob()); } catch {}
    if (img.displayUrl && img.displayUrl.startsWith('data:')) return dataURItoBlob(img.displayUrl);
    try { return await (await fetch(img.url)).blob(); } catch { try { const res = await browser.tabs.sendMessage(currentTabId, { type: "CONVERT_IMAGE", url: img.url }); return res?.dataUrl ? dataURItoBlob(res.dataUrl) : null; } catch { return null; } }
}

function queueForHashing(img, item) {
    if (img.hashChecked || img.filtered || img.sizeFiltered) return; img.hashChecked = true;
    hashQueue.push(async () => {
        if (img.sha256) {
            if (contentHashes.has(img.sha256) && !img.isFirstHashInstance) { img.filtered = img.hashFiltered = true; img.selected = false; if (item?.parentNode) item.parentNode.removeChild(item); debounceUpdateUI(); }
            else { contentHashes.add(img.sha256); img.isFirstHashInstance = true; }
            return;
        }
        try {
            const blob = await getBlobForDownload(img); if (!blob) return;
            const hash = await computeSHA256(blob); if (!hash) return;
            img.sha256 = hash;
            if (contentHashes.has(hash)) { img.filtered = img.hashFiltered = true; img.selected = false; if (item?.parentNode) item.parentNode.removeChild(item); debounceUpdateUI(); }
            else { contentHashes.add(hash); img.isFirstHashInstance = true; }
        } catch {}
    });
}

function updateProgress() {
    if (unscrambleTotal > 0) {
        dom.status.textContent = `Descrambling ${unscrambleDone}/${unscrambleTotal}...`;
        if (unscrambleDone >= unscrambleTotal) setTimeout(() => { if (unscrambleDone >= unscrambleTotal) { dom.status.textContent = "Ready"; unscrambleTotal = unscrambleDone = 0; } }, 1500);
    }
}

function saveState(immediate = false) {
    if (!stateLoaded) return; clearTimeout(saveTimeout);
    const doSave = () => { if (currentTabId) browser.runtime.sendMessage({ type: "SAVE_STATE", tabId: currentTabId, state: { images, pageTitle, scrollPosition: dom.gridContainer.scrollTop, networkMode: fetchMode, tabUrl: currentTabUrl } }).catch(() => {}); };
    immediate ? doSave() : (saveTimeout = setTimeout(doSave, 1500));
}
window.addEventListener("pagehide", () => saveState(true)); window.addEventListener("blur", () => saveState(true));

function clearAllCache() { 
    for (let i = 0; i < images.length; i++) { if (images[i].unscrambledUrl) URL.revokeObjectURL(images[i].unscrambledUrl); if (images[i].displayUrl?.startsWith('blob:')) URL.revokeObjectURL(images[i].displayUrl); }
    images = []; uidCounter = unscrambleTotal = unscrambleDone = 0; contentHashes.clear(); renderQueue = []; dom.grid.innerHTML = "";
}

function updateSliderTrack(track, minInput, maxInput) {
    const min = parseInt(minInput.min, 10), max = parseInt(minInput.max, 10), vMin = parseInt(minInput.value, 10), vMax = parseInt(maxInput.value, 10);
    track.style.left = Math.max(0, Math.min(100, ((vMin - min) / (max - min)) * 100)) + "%"; track.style.width = (Math.max(0, Math.min(100, ((vMax - min) / (max - min)) * 100)) - Math.max(0, Math.min(100, ((vMin - min) / (max - min)) * 100))) + "%";
}

function updateInputStates() {
    dom.widthInputMin.disabled = dom.widthSliderMin.disabled = !dom.widthCheckMin.checked; dom.widthInputMax.disabled = dom.widthSliderMax.disabled = !dom.widthCheckMax.checked;
    dom.heightInputMin.disabled = dom.heightSliderMin.disabled = !dom.heightCheckMin.checked; dom.heightInputMax.disabled = dom.heightSliderMax.disabled = !dom.heightCheckMax.checked;
}

function filterImages() {
    const minW = dom.widthCheckMin.checked ? (parseInt(dom.widthInputMin.value, 10) || 0) : 0, maxW = dom.widthCheckMax.checked ? (parseInt(dom.widthInputMax.value, 10) || 99999) : 99999;
    const minH = dom.heightCheckMin.checked ? (parseInt(dom.heightInputMin.value, 10) || 0) : 0, maxH = dom.heightCheckMax.checked ? (parseInt(dom.heightInputMax.value, 10) || 99999) : 99999;
    let changed = false;
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (img.filtered || img.width === undefined || img.height === undefined) continue;
        const shouldHide = img.width < minW || img.width > maxW || img.height < minH || img.height > maxH;
        if (img.sizeFiltered !== shouldHide) { img.sizeFiltered = shouldHide; changed = true; const item = document.getElementById(`item-${img.uid}`); if (item) item.style.display = shouldHide ? 'none' : ''; }
    }
    if (changed) debounceUpdateUI();
}

function handleSliderInput(e) {
    const isW = e.target.id.includes("width"), [minS, maxS, minI, maxI] = isW ? [dom.widthSliderMin, dom.widthSliderMax, dom.widthInputMin, dom.widthInputMax] : [dom.heightSliderMin, dom.heightSliderMax, dom.heightInputMin, dom.heightInputMax];
    let minVal = parseInt(minS.value, 10), maxVal = parseInt(maxS.value, 10);
    if (minVal > maxVal) { if (e.target === minS) { minS.value = maxVal; minVal = maxVal; } else { maxS.value = minVal; maxVal = minVal; } }
    minI.value = minVal; maxI.value = maxVal; updateSliderTrack(isW ? dom.widthTrack : dom.heightTrack, minS, maxS); filterImages();
}

function handleManualInput(e) {
    const isW = e.target.id.includes("width"), [minS, maxS] = isW ? [dom.widthSliderMin, dom.widthSliderMax] : [dom.heightSliderMin, dom.heightSliderMax];
    let val = parseInt(e.target.value, 10); if (isNaN(val)) return;
    if (e.target.id.includes("Min")) minS.value = Math.min(val, parseInt(maxS.value, 10)); else maxS.value = Math.max(val, parseInt(minS.value, 10));
    updateSliderTrack(isW ? dom.widthTrack : dom.heightTrack, minS, maxS); filterImages();
}

[dom.widthSliderMin, dom.widthSliderMax, dom.heightSliderMin, dom.heightSliderMax].forEach(el => el.addEventListener('input', handleSliderInput));
[dom.widthInputMin, dom.widthInputMax, dom.heightInputMin, dom.heightInputMax].forEach(el => el.addEventListener('input', handleManualInput));
[dom.widthCheckMin, dom.widthCheckMax, dom.heightCheckMin, dom.heightCheckMax].forEach(cb => cb.addEventListener('change', () => { updateInputStates(); filterImages(); }));

updateInputStates(); updateSliderTrack(dom.widthTrack, dom.widthSliderMin, dom.widthSliderMax); updateSliderTrack(dom.heightTrack, dom.heightSliderMin, dom.heightSliderMax);

function getCanonicalUrl(url) { try { const u = new URL(url); return /\.(jpg|jpeg|png|webp|gif|svg|bmp|tiff)($|\?)/i.test(u.pathname) ? u.origin + u.pathname : u.href; } catch { return url; } }
function extractFilename(url) { try { return decodeURIComponent(url).split('?')[0].split('#')[0].replace(/\/$/, "").split('/').pop() || "image"; } catch { return "image"; } }
function extractExtension(url) { try { const p = new URL(url).pathname, d = p.lastIndexOf("."); return (d === -1 || d === p.length - 1) ? "zz_unknown" : p.substring(d + 1).toLowerCase(); } catch { return "zz_unknown"; } }

async function unscrambleImageProcess(imgObj, data) {
    try {
        let loadUrl = imgObj.url, isBlobObj = false;
        if (imgObj.url.startsWith('blob:')) { const res = await browser.tabs.sendMessage(currentTabId, { type: "CONVERT_IMAGE", url: imgObj.url }); if (res?.dataUrl) loadUrl = res.dataUrl; else return imgObj.url; }
        else { loadUrl = URL.createObjectURL(await fetch(imgObj.url).then(r => r.blob())); isBlobObj = true; }
        const img = new Image();
        return new Promise((resolve) => {
            img.onload = () => { const canvas = document.createElement("canvas"); canvas.width = data.width; canvas.height = data.height; data.instructions.forEach(op => canvas.getContext("2d").drawImage(img, op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh)); resolve(canvas.toDataURL("image/jpeg", 0.95)); if (isBlobObj) URL.revokeObjectURL(loadUrl); };
            img.onerror = () => { if (isBlobObj) URL.revokeObjectURL(loadUrl); resolve(imgObj.url); };
            img.src = loadUrl;
        });
    } catch { return imgObj.url; }
}

function startUnscramble(img, initialImgEl, data) {
    if (img.queuedForUnscramble || img.unscrambledUrl) return;
    img.queuedForUnscramble = true; unscrambleTotal++; updateProgress();
    unscrambleQueue.push(async () => {
        if (img.unscrambledUrl) { unscrambleDone++; updateProgress(); return; }
        const newUrl = await unscrambleImageProcess(img, data);
        img.unscrambledUrl = img.displayUrl = newUrl; unscrambleDone++; updateProgress();
        const item = document.getElementById(`item-${img.uid}`);
        if (item) { const cImg = item.querySelector('img'); if (cImg) cImg.src = newUrl; } else if (initialImgEl?.isConnected) initialImgEl.src = newUrl;
        browser.runtime.sendMessage({ type: "UPDATE_IMAGE_STATE", tabId: currentTabId, uid: img.uid, displayUrl: newUrl }).catch(()=>{});
    });
}

function render() { dom.grid.innerHTML = ""; renderQueue = [...images]; requestAnimationFrame(processRenderQueue); debounceUpdateUI(); }

function performSort() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < images.length; i++) { const item = document.getElementById(`item-${images[i].uid}`); if (item) fragment.appendChild(item); }
    dom.grid.appendChild(fragment); debounceUpdateUI();
}

function processRenderQueue() {
    if (renderQueue.length === 0) return;
    const fragment = document.createDocumentFragment(), batch = renderQueue.splice(0, 60);
    const minW = dom.widthCheckMin.checked ? parseInt(dom.widthInputMin.value, 10) || 0 : 0, maxW = dom.widthCheckMax.checked ? parseInt(dom.widthInputMax.value, 10) || 99999 : 99999;
    const minH = dom.heightCheckMin.checked ? parseInt(dom.heightInputMin.value, 10) || 0 : 0, maxH = dom.heightCheckMax.checked ? parseInt(dom.heightInputMax.value, 10) || 99999 : 99999;

    for (let i = 0; i < batch.length; i++) {
        const img = batch[i]; if (img.filtered) continue;
        if (!img.uid) img.uid = ++uidCounter;
        const item = document.createElement("div"); item.className = `item ${img.selected ? 'selected' : ''}`; item.id = `item-${img.uid}`; item.dataset.uid = img.uid;
        if (img.sizeFiltered) item.style.display = 'none';

        const imgEl = document.createElement("img"); imgEl.decoding = "async";
        let scrambledData = unscrambleMap[img.url] || unscrambleMap[getCanonicalUrl(img.url)] || unscrambleMap[img.url.split('?')[0]] || unscrambleMap[decodeURIComponent(img.url)];

        if (scrambledData && scrambledData.instructions.length > 0) {
            if (img.unscrambledUrl) { imgEl.src = img.displayUrl = img.unscrambledUrl; } else { imgEl.src = img.url; startUnscramble(img, imgEl, scrambledData); }
        } else if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) { imgEl.src = PLACEHOLDER_SVG; fetchQueue.push(() => handleImageError(img, item, imgEl)); } 
        else imgEl.src = img.displayUrl || img.url;

        imgEl.onload = function() {
            if (this.src === PLACEHOLDER_SVG) return;
            const w = img.width = this.naturalWidth, h = img.height = this.naturalHeight;
            if (w > 0 && h > 0 && w < MIN_SIZE && h < MIN_SIZE) { img.filtered = true; if (item.parentNode) item.parentNode.removeChild(item); debounceUpdateUI(); return; }
            if (w < minW || w > maxW || h < minH || h > maxH) { if (!img.sizeFiltered) { img.sizeFiltered = true; item.style.display = 'none'; debounceUpdateUI(); } }
            else if (img.sizeFiltered) { img.sizeFiltered = false; item.style.display = ''; debounceUpdateUI(); }
            imgEl.classList.add('loaded'); if (w) img.pixelCount = w * h;
            if (w > 0 && h > 0) { const dimLabel = document.createElement('div'); dimLabel.className = 'dim-label'; dimLabel.textContent = `${w}x${h}`; item.appendChild(dimLabel); }
            if (!img.filtered && !img.sizeFiltered) queueForHashing(img, item);
        };
        imgEl.onerror = () => fetchQueue.push(() => handleImageError(img, item, imgEl));
        item.appendChild(imgEl); fragment.appendChild(item);
    }
    dom.grid.appendChild(fragment);
    if (targetScrollPosition > 0 && dom.gridContainer.scrollHeight >= targetScrollPosition + dom.gridContainer.clientHeight) { dom.gridContainer.scrollTop = targetScrollPosition; targetScrollPosition = 0; }
    if (renderQueue.length > 0) requestAnimationFrame(processRenderQueue);
}

function createImageIdentifier(url) { try { const u = new URL(url); return (/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(u.pathname) ? u.origin + u.pathname : u.href) + "::" + extractFilename(url); } catch { return url + "::" + extractFilename(url); } }

async function handleImageError(img, itemEl, imgEl) {
    let stage = parseInt(imgEl.dataset.retryStage || "0", 10);
    if (stage >= 2) { if (itemEl) { itemEl.style.opacity = '0.5'; itemEl.style.pointerEvents = 'none'; } return; }
    if (img.url.startsWith('blob:') && stage === 0) stage = 1; 
    imgEl.dataset.retryStage = ++stage;
    try {
        const res = await (stage === 1 ? browser.runtime : browser.tabs).sendMessage(currentTabId, { type: stage === 1 ? "FETCH_IMAGE_BLOB" : "CONVERT_IMAGE", url: img.url, tabId: currentTabId });
        if (res?.dataUrl?.startsWith('data:')) { img.displayUrl = imgEl.src = res.dataUrl; saveState(); return; }
    } catch {}
    if(stage===1) await handleImageError(img, itemEl, imgEl);
}

function convertEssentialImages() { images.forEach(img => { if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) { const item = document.getElementById(`item-${img.uid}`); if(item) fetchQueue.push(() => handleImageError(img, item, item.querySelector('img'))); } }); }
function setNetworkMode(mode) { if (currentTabId) browser.runtime.sendMessage({ type: "SET_NETWORK_MODE", tabId: currentTabId, networkMode: mode }).catch(()=>{}); }
async function checkTabOrUrlChange() { try { const [tab] = await browser.tabs.query({ active: true, currentWindow: true }); return tab && (tab.id !== currentTabId || tab.url !== currentTabUrl); } catch { return false; } }
async function fetchUnscrambleMap() { try { const res = await browser.tabs.sendMessage(currentTabId, { type: "GET_UNSCRAMBLE_DATA" }); if (res?.map) unscrambleMap = res.map; } catch {} }

async function init() {
    stateLoaded = false;
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        currentTabId = tab.id; currentTabUrl = tab.url; if (tab.title) pageTitle = tab.title;
        const activeRes = await browser.runtime.sendMessage({ type: "GET_TASK_PROGRESS" }).catch(()=>null);
        if (activeRes?.task) pollProgress();
        
        browser.runtime.onMessage.addListener((msg) => {
            if (msg.type === "CANVAS_MAP_PUSH" && msg.map) {
                Object.assign(unscrambleMap, msg.map);
                images.forEach(img => {
                    if (!img.unscrambledUrl && !img.queuedForUnscramble) {
                        const data = unscrambleMap[img.url] || unscrambleMap[getCanonicalUrl(img.url)] || unscrambleMap[img.url.split('?')[0]] || unscrambleMap[decodeURIComponent(img.url)];
                        if (data) { const item = document.getElementById(`item-${img.uid}`); if (item) startUnscramble(img, item.querySelector('img'), data); }
                    }
                });
            }
        });

        try {
            const saved = await browser.runtime.sendMessage({ type: "GET_STATE", tabId: currentTabId });
            if (saved?.state?.networkMode !== undefined) { fetchMode = saved.state.networkMode; updateNetworkModeUI(); setNetworkMode(fetchMode); }
            if (saved?.state?.tabUrl && saved.state.tabUrl !== currentTabUrl) { clearAllCache(); await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId }).catch(()=>{}); }
            else if (saved?.state?.images?.length) {
                images = saved.state.images; let maxUid = 0;
                images.forEach(imgObj => {
                    if(!imgObj.uid) imgObj.uid = ++uidCounter; else if(imgObj.uid > uidCounter) maxUid = imgObj.uid;
                    if (!imgObj.unscrambledUrl) imgObj.queuedForUnscramble = false;
                    if (imgObj.sha256 && !imgObj.filtered && !imgObj.hashFiltered) { if (contentHashes.has(imgObj.sha256)) { imgObj.filtered = imgObj.hashFiltered = true; imgObj.selected = false; } else { contentHashes.add(imgObj.sha256); imgObj.isFirstHashInstance = imgObj.hashChecked = true; } } else imgObj.hashChecked = false;
                });
                uidCounter = Math.max(uidCounter, maxUid); images.sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
                pageTitle = saved.state.pageTitle; targetScrollPosition = saved.state.scrollPosition || 0;
                dom.status.textContent = "Restored"; await fetchUnscrambleMap(); render(); stateLoaded = true; return;
            }
        } catch {}
        
        stateLoaded = true; setNetworkMode(fetchMode); dom.status.textContent = "Scanning..."; await fetchUnscrambleMap();

        if (fetchMode === 'network') { addFoundImages((await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>{}))?.images || []); }
        else if (fetchMode === 'blob') { addFoundImages((await browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(()=>{}))?.urls || []); }
        else {
            const [p, c, n, b] = await Promise.all([browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(()=>({})), browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS", mode: fetchMode }).catch(()=>({})), browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({})), browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(()=>({}))]);
            if (p?.title) pageTitle = p.title;
            addFoundImages([...(p?.items || (p?.urls || []).map(url => ({url}))), ...(c?.urls||[]).map(url => ({url})), ...(n?.images||[]).map(url => ({url})), ...(b?.urls||[]).map(url => ({url}))]);
        }
    } catch { dom.status.textContent = "Refresh page needed"; }
}
init().then(startAutoReload);

function updateUI(shouldSave = true) {
    let validCount = 0, selCount = 0;
    images.forEach(i => { if (!i.filtered && !i.sizeFiltered) { validCount++; if (i.selected) selCount++; } });
    dom.tracker.textContent = validCount === 0 ? "No images" : `${selCount} / ${validCount}`;
    dom.toggleBtn.textContent = (selCount < validCount) ? "Select All" : "Deselect All";
    if (dom.downloadBtn.textContent !== "Stop" && dom.zipBtn.textContent !== "Stop") dom.downloadBtn.disabled = dom.zipBtn.disabled = selCount === 0;
    if (shouldSave) saveState();
}

function updateNetworkModeUI() {
    dom.networkToggle.classList.remove('network-active', 'blob-active'); dom.modeDefault.checked = dom.modeNetwork.checked = dom.modeBlob.checked = false;
    if (fetchMode === 'network') { dom.networkToggle.textContent = "Network"; dom.networkToggle.classList.add('network-active'); dom.modeNetwork.checked = true; }
    else if (fetchMode === 'blob') { dom.networkToggle.textContent = "Scrapper"; dom.networkToggle.classList.add('blob-active'); dom.modeBlob.checked = true; }
    else { dom.networkToggle.textContent = "Default"; dom.modeDefault.checked = true; }
}

dom.grid.addEventListener('click', (e) => {
    const item = e.target.closest('.item'); if (!item) return;
    const img = images.find(i => i.uid === parseInt(item.dataset.uid, 10));
    if (img) { img.selected = !img.selected; item.classList.toggle('selected', img.selected); debounceUpdateUI(); saveState(); }
});

dom.toggleBtn.onclick = () => {
    const targetState = images.some(i => !i.filtered && !i.sizeFiltered && !i.selected);
    images.forEach(img => { if (!img.filtered && !img.sizeFiltered) { img.selected = targetState; document.getElementById(`item-${img.uid}`)?.classList.toggle('selected', targetState); } });
    updateUI(true);
};

dom.renameToggle.onclick = () => { renameMode = !renameMode; dom.renameToggle.textContent = renameMode ? "Rename" : "Original"; dom.renameToggle.classList.toggle('original-mode', !renameMode); };

async function switchMode(newMode) {
    if (fetchMode === newMode) return;
    clearAllCache(); await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId }).catch(()=>{}); render();
    fetchMode = newMode; updateNetworkModeUI(); setNetworkMode(fetchMode); saveState(true); await init();
}

dom.modeDefault.onclick = () => switchMode('default'); dom.modeNetwork.onclick = () => switchMode('network'); dom.modeBlob.onclick = () => switchMode('blob');

dom.sortBtn.onclick = () => {
    if (!sortOrder) { sortOrder = 'reverse'; dom.sortBtn.textContent = "Reverse"; } else if (sortOrder === 'reverse') { sortOrder = 'name'; dom.sortBtn.textContent = "Name"; } else if (sortOrder === 'name') { sortOrder = 'asc'; dom.sortBtn.textContent = "Asc ↓"; } else if (sortOrder === 'asc') { sortOrder = 'desc'; dom.sortBtn.textContent = "Dsc ↑"; } else { sortOrder = null; dom.sortBtn.textContent = "Sort ⇅"; }
    setTimeout(() => {
        images.sort((a,b) => {
            if (sortOrder === 'reverse') return (b.sortOrder||0) - (a.sortOrder||0);
            if (sortOrder === 'name') { const baseA = a._name.split('.').slice(0,-1).join('.') || a._name, baseB = b._name.split('.').slice(0,-1).join('.') || b._name, numA = parseInt(baseA.match(/\d+$/)?.[0] || '0', 10), numB = parseInt(baseB.match(/\d+$/)?.[0] || '0', 10); return (numA && numB && numA !== numB) ? numA - numB : a._name.localeCompare(b._name); }
            if (sortOrder === 'asc') { const diff = (a.pixelCount||0) - (b.pixelCount||0); return diff !== 0 ? diff : (a.sortOrder||0) - (b.sortOrder||0); }
            if (sortOrder === 'desc') { const diff = (b.pixelCount||0) - (a.pixelCount||0); return diff !== 0 ? diff : (a.sortOrder||0) - (b.sortOrder||0); }
            return (a.sortOrder||0) - (b.sortOrder||0);
        }); performSort();
    }, 10);
};

dom.clearCache.onclick = async () => { if (window.confirm("Clear all cached images for this tab?")) { clearAllCache(); await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId }); render(); saveState(true); dom.status.textContent = "Scanning..."; await init(); } };

function addFoundImages(items) {
    const currentIds = new Set(images.map(i => createImageIdentifier(i.url))); let added = 0;
    const startOrder = images.length > 0 ? Math.max(...images.map(i => i.sortOrder||0)) + 1 : 0;
    items.forEach((item, idx) => {
        let url = typeof item === 'string' ? item : item.url, w = item.w, h = item.h;
        if (w > 0 && h > 0 && w < MIN_SIZE && h < MIN_SIZE) return;
        const id = createImageIdentifier(url);
        if (!currentIds.has(id)) { images.push({ url, displayUrl: url, selected: true, originalIndex: images.length + 1, sortOrder: startOrder + idx, uid: ++uidCounter, _name: extractFilename(url), _ext: extractExtension(url), width: w, height: h }); currentIds.add(id); added++; }
    });
    if (added > 0) { render(); saveState(); convertEssentialImages(); dom.status.textContent = "Scan done"; setTimeout(() => { if(dom.status.textContent === "Scan done") dom.status.textContent = "Ready"; }, 2000); }
    else if (images.length === 0) { render(); dom.status.textContent = "No images found"; }
}

async function startAutoReload() {
    const loop = async () => {
        if (!currentTabId) return;
        if (await checkTabOrUrlChange()) {
            clearAllCache(); const [tab] = await browser.tabs.query({ active: true, currentWindow: true }); if (tab) { currentTabId = tab.id; currentTabUrl = tab.url; }
            await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId }).catch(()=>{}); await init(); setTimeout(loop, 3500); return;
        }
        try {
            await fetchUnscrambleMap(); 
            if (fetchMode === 'network') { addFoundImages(((await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>{}))?.images || []).map(url=>({url}))); }
            else if (fetchMode === 'blob') { addFoundImages(((await browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(()=>{}))?.urls || []).map(url=>({url}))); }
            else {
                const [p, c, n, b] = await Promise.all([browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(()=>({})), browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS", mode: fetchMode }).catch(()=>({})), browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({})), browser.tabs.sendMessage(currentTabId, { type: "SCAN_BLOBS" }).catch(()=>({}))]);
                addFoundImages([...(p?.items || (p?.urls || []).map(url=>({url}))), ...(c?.urls||[]).map(url=>({url})), ...(n?.images||[]).map(url=>({url})), ...(b?.urls||[]).map(url=>({url}))]);
            }
        } catch {} setTimeout(loop, 3500);
    }; loop();
}

function dataURItoBlob(dataURI) {
    try { const split = dataURI.split(','), bytes = atob(split[1]), ia = new Uint8Array(bytes.length); for (let i = 0; i < bytes.length; i++) ia[i] = bytes.charCodeAt(i); return new Blob([ia], {type: split[0].split(':')[1].split(';')[0]}); } catch { return null; }
}

function pollProgress() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(async () => {
        const res = await browser.runtime.sendMessage({ type: "GET_TASK_PROGRESS" }).catch(()=>null);
        if (res?.task) {
            dom.status.textContent = res.task.statusText;
            if (res.task.type === 'zip') { dom.zipBtn.textContent = "Stop"; dom.downloadBtn.disabled = true; } else { dom.downloadBtn.textContent = "Stop"; dom.zipBtn.disabled = true; }
            if (["Done!", "Error"].includes(res.task.statusText) || res.task.cancel) { clearInterval(progressInterval); resetButtons(); }
        } else { clearInterval(progressInterval); resetButtons(); }
    }, 500);
}

function resetButtons() { dom.downloadBtn.textContent = "Download"; dom.zipBtn.textContent = "ZIP"; updateUI(false); }

function prepareTaskItems(taskType) {
    if (taskType === "Stop") { browser.runtime.sendMessage({ type: "STOP_TASK" }); return null; }
    const valid = images.filter(i => i.selected && !i.filtered && !i.sizeFiltered); if (!valid.length) return null;
    dom[taskType === "START_DOWNLOAD" ? "downloadBtn" : "zipBtn"].textContent = "Stop"; dom[taskType === "START_DOWNLOAD" ? "zipBtn" : "downloadBtn"].disabled = true;
    return (sortOrder ? [...valid] : [...valid].sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0))).map(i => ({ url: i.url, displayUrl: i.displayUrl, _name: i._name, originalIndex: images.indexOf(i) }));
}

dom.downloadBtn.onclick = async () => {
    const items = prepareTaskItems(dom.downloadBtn.textContent === "Stop" ? "Stop" : "START_DOWNLOAD"); if (!items) return;
    await browser.runtime.sendMessage({ type: "START_DOWNLOAD", items, options: { renameMode, folder: (dom.folderName.value.trim().replace(/\/$/, "") || "").replace(/[^a-z0-9_-]/gi, "_").substring(0, 50), isAndroid, pageTitle }, tabId: currentTabId }); pollProgress();
};

dom.zipBtn.onclick = async () => {
    const items = prepareTaskItems(dom.zipBtn.textContent === "Stop" ? "Stop" : "START_ZIP"); if (!items) return;
    await browser.runtime.sendMessage({ type: "START_ZIP", items, options: { renameMode, folder: (dom.folderName.value.trim().replace(/\/$/, "") || "").replace(/[^a-z0-9_-]/gi, "_").substring(0, 50), isAndroid, pageTitle }, tabId: currentTabId }); pollProgress();
};

updateNetworkModeUI(); dom.settingsBtn.onclick = () => dom.settingsPanel.classList.remove('hidden'); dom.closeSettings.onclick = () => dom.settingsPanel.classList.add('hidden');
