const isAndroid = /Android/i.test(navigator.userAgent);
if (isAndroid) document.documentElement.classList.add("android");

const MIN_SIZE = 50;
const PLACEHOLDER_SVG = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBmaWxsPSIjZWRlZGVkIiBkPSJNMCAwaDI0djI0SDB6Ii8+PC9zdmc+";

let images = [];
let currentTabId = null;
let currentTabUrl = null; 
let pageTitle = "images";
let allSelected = true;
let renameMode = true;
let networkMode = false;
let saveTimeout = null;
let renderQueue = [];
let targetScrollPosition = 0;
let sortOrder = null;
let uidCounter = 0;

// Polyfill for requestIdleCallback
const idleCallback = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));

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
    heightCheckMax: document.getElementById("heightCheckMax")
};

function updateInputStates() {
    dom.widthInputMin.disabled = dom.widthSliderMin.disabled = !dom.widthCheckMin.checked;
    dom.widthInputMax.disabled = dom.widthSliderMax.disabled = !dom.widthCheckMax.checked;
    dom.heightInputMin.disabled = dom.heightSliderMin.disabled = !dom.heightCheckMin.checked;
    dom.heightInputMax.disabled = dom.heightSliderMax.disabled = !dom.heightCheckMax.checked;
}

class AsyncQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }
    push(task) {
        this.queue.push(task);
        this.next();
    }
    next() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            this.running++;
            task().finally(() => {
                this.running--;
                this.next();
            });
        }
    }
}
const fetchQueue = new AsyncQueue(4);

function saveState(immediate = false) {
    clearTimeout(saveTimeout);
    const doSave = () => {
        if (!currentTabId) return;
        idleCallback(() => {
            browser.runtime.sendMessage({
                type: "SAVE_STATE",
                tabId: currentTabId,
                state: { 
                    images, 
                    pageTitle, 
                    scrollPosition: dom.gridContainer.scrollTop, 
                    networkMode,
                    tabUrl: currentTabUrl 
                }
            }).catch(() => {});
        }, { timeout: 2000 });
    };
    if (immediate) doSave();
    else saveTimeout = setTimeout(doSave, 1500);
}
window.addEventListener("pagehide", () => saveState(true));
window.addEventListener("blur", () => saveState(true));

function clearAllCache() {
    images = [];
    uidCounter = 0;
}

function updateSliderTrack(track, minInput, maxInput) {
    const min = parseInt(minInput.min), max = parseInt(minInput.max);
    const vMin = parseInt(minInput.value), vMax = parseInt(maxInput.value);
    const percent1 = Math.max(0, Math.min(100, ((vMin - min) / (max - min)) * 100));
    const percent2 = Math.max(0, Math.min(100, ((vMax - min) / (max - min)) * 100));
    track.style.left = percent1 + "%";
    track.style.width = (percent2 - percent1) + "%";
}

function filterImages() {
    const useMinW = dom.widthCheckMin.checked, useMaxW = dom.widthCheckMax.checked;
    const useMinH = dom.heightCheckMin.checked, useMaxH = dom.heightCheckMax.checked;
    const minW = useMinW ? (parseInt(dom.widthInputMin.value) || 0) : 0;
    const maxW = useMaxW ? (parseInt(dom.widthInputMax.value) || 99999) : 99999;
    const minH = useMinH ? (parseInt(dom.heightInputMin.value) || 0) : 0;
    const maxH = useMaxH ? (parseInt(dom.heightInputMax.value) || 99999) : 99999;
    
    let changed = false;
    images.forEach((img) => {
        if (img.filtered) return;
        if (img.width !== undefined && img.height !== undefined) {
            const shouldHide = img.width < minW || img.width > maxW || img.height < minH || img.height > maxH;
            if (img.sizeFiltered !== shouldHide) {
                img.sizeFiltered = shouldHide;
                changed = true;
                const item = document.getElementById(`item-${img.uid}`);
                if (item) item.style.display = shouldHide ? 'none' : '';
            }
        }
    });
    if (changed) updateUI(false);
}

function handleSliderInput(e) {
    const isW = e.target.id.includes("width");
    const minSlider = isW ? dom.widthSliderMin : dom.heightSliderMin;
    const maxSlider = isW ? dom.widthSliderMax : dom.heightSliderMax;
    const minInput = isW ? dom.widthInputMin : dom.heightInputMin;
    const maxInput = isW ? dom.widthInputMax : dom.heightInputMax;
    
    let minVal = parseInt(minSlider.value), maxVal = parseInt(maxSlider.value);
    if (minVal > maxVal) {
        if (e.target === minSlider) { minSlider.value = maxVal; minVal = maxVal; } 
        else { maxSlider.value = minVal; maxVal = minVal; }
    }
    minInput.value = minVal; maxInput.value = maxVal;
    updateSliderTrack(isW ? dom.widthTrack : dom.heightTrack, minSlider, maxSlider);
    filterImages();
}

function handleManualInput(e) {
    const isW = e.target.id.includes("width");
    const minSlider = isW ? dom.widthSliderMin : dom.heightSliderMin;
    const maxSlider = isW ? dom.widthSliderMax : dom.heightSliderMax;
    let val = parseInt(e.target.value);
    if (isNaN(val)) return;
    
    if (e.target.id.includes("Min")) {
        const otherVal = parseInt(maxSlider.value);
        minSlider.value = Math.min(val, otherVal);
    } else {
        const otherVal = parseInt(minSlider.value);
        maxSlider.value = Math.max(val, otherVal);
    }
    updateSliderTrack(isW ? dom.widthTrack : dom.heightTrack, minSlider, maxSlider);
    filterImages();
}

[dom.widthSliderMin, dom.widthSliderMax, dom.heightSliderMin, dom.heightSliderMax].forEach(el => el.addEventListener('input', handleSliderInput));
[dom.widthInputMin, dom.widthInputMax, dom.heightInputMin, dom.heightInputMax].forEach(el => el.addEventListener('input', handleManualInput));
[dom.widthCheckMin, dom.widthCheckMax, dom.heightCheckMin, dom.heightCheckMax].forEach(cb => {
    cb.addEventListener('change', () => { updateInputStates(); filterImages(); });
});
updateInputStates();
updateSliderTrack(dom.widthTrack, dom.widthSliderMin, dom.widthSliderMax);
updateSliderTrack(dom.heightTrack, dom.heightSliderMin, dom.heightSliderMax);

function render() {
    dom.grid.innerHTML = "";
    renderQueue = [...images];
    requestAnimationFrame(() => processRenderQueue());
    updateUI(false);
}

// Optimized Re-sort without destroying DOM
function performSort() {
    const fragment = document.createDocumentFragment();
    images.forEach(img => {
        const item = document.getElementById(`item-${img.uid}`);
        if (item) fragment.appendChild(item);
    });
    dom.grid.appendChild(fragment);
    updateUI(false);
}

function processRenderQueue() {
    if (renderQueue.length === 0) return;
    const fragment = document.createDocumentFragment();
    const batch = renderQueue.splice(0, 60);
    
    const useMinW = dom.widthCheckMin.checked, useMaxW = dom.widthCheckMax.checked;
    const useMinH = dom.heightCheckMin.checked, useMaxH = dom.heightCheckMax.checked;
    const minW = useMinW ? (parseInt(dom.widthInputMin.value) || 0) : 0;
    const maxW = useMaxW ? (parseInt(dom.widthInputMax.value) || 99999) : 99999;
    const minH = useMinH ? (parseInt(dom.heightInputMin.value) || 0) : 0;
    const maxH = useMaxH ? (parseInt(dom.heightInputMax.value) || 99999) : 99999;

    batch.forEach(img => {
        if (img.filtered) return;
        
        // Ensure UID
        if (!img.uid) img.uid = ++uidCounter;

        const item = document.createElement("div");
        item.className = `item ${img.selected ? 'selected' : ''}`;
        item.id = `item-${img.uid}`;
        item.dataset.uid = img.uid;
        
        if (img.sizeFiltered) item.style.display = 'none';

        const imgEl = document.createElement("img");
        imgEl.decoding = "async";
        
        if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) {
            imgEl.src = PLACEHOLDER_SVG;
            fetchQueue.push(() => handleImageError(img, item, imgEl));
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
                updateUI(false);
                return;
            }

            if (w < minW || w > maxW || h < minH || h > maxH) {
                img.sizeFiltered = true;
                item.style.display = 'none';
                updateUI(false);
            } else if (img.sizeFiltered) {
                img.sizeFiltered = false;
                item.style.display = '';
                updateUI(false);
            }
            imgEl.classList.add('loaded');
            if (w) img.pixelCount = w * h;
        };
        imgEl.onerror = () => fetchQueue.push(() => handleImageError(img, item, imgEl));
        item.appendChild(imgEl);
        fragment.appendChild(item);
    });
    dom.grid.appendChild(fragment);
    
    if (targetScrollPosition > 0 && dom.gridContainer.scrollHeight >= targetScrollPosition + dom.gridContainer.clientHeight) {
        dom.gridContainer.scrollTop = targetScrollPosition;
        targetScrollPosition = 0;
    }
    if (renderQueue.length > 0) requestAnimationFrame(() => processRenderQueue());
}

function getFilename(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return "image";
    try {
        const base = decodeURIComponent(url).split('?')[0].split('#')[0];
        const name = (base.endsWith('/') ? base.slice(0, -1) : base).split('/').pop();
        return name || "image";
    } catch { return "image"; }
}

function createImageIdentifier(url) {
    try {
        const u = new URL(url);
        return (/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(u.pathname) ? u.origin + u.pathname : u.href) + "::" + getFilename(url);
    } catch { return url + "::" + getFilename(url); }
}

async function handleImageError(img, itemEl, imgEl) {
    let stage = parseInt(imgEl.dataset.retryStage || "0");
    if (stage >= 2) {
        if (itemEl) { itemEl.style.opacity = '0.5'; itemEl.style.pointerEvents = 'none'; }
        return;
    }
    stage++;
    imgEl.dataset.retryStage = stage;
    try {
        const msgType = stage === 1 ? "FETCH_IMAGE_BLOB" : "CONVERT_IMAGE";
        const target = stage === 1 ? browser.runtime : browser.tabs;
        const res = await target.sendMessage(currentTabId, { type: msgType, url: img.url, tabId: currentTabId });
        if (res?.dataUrl && res.dataUrl.startsWith('data:')) {
            img.displayUrl = res.dataUrl;
            imgEl.src = res.dataUrl;
            saveState();
            return;
        }
    } catch {}
    if(stage===1) await handleImageError(img, itemEl, imgEl);
}

async function convertEssentialImages() {
    images.forEach((img) => {
        if (img.url.startsWith('blob:') && !img.displayUrl.startsWith('data:')) {
            const item = document.getElementById(`item-${img.uid}`);
            if(item) fetchQueue.push(() => handleImageError(img, item, item.querySelector('img')));
        }
    });
}

async function setNetworkMode(mode) {
    if (currentTabId) await browser.runtime.sendMessage({ type: "SET_NETWORK_MODE", tabId: currentTabId, networkMode: mode }).catch(console.error);
}

async function checkUrlChange() {
    if (!currentTabId) return false;
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        return tab && tab.url !== currentTabUrl;
    } catch { return false; }
}

async function init() {
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        currentTabId = tab.id;
        currentTabUrl = tab.url; 
        
        // FIX: Ensure pageTitle is initialized from the tab immediately
        if (tab.title) pageTitle = tab.title;

        try {
            const saved = await browser.runtime.sendMessage({ type: "GET_STATE", tabId: currentTabId });
            const urlChanged = saved?.state?.tabUrl && saved.state.tabUrl !== currentTabUrl;
            
            if (urlChanged) {
                clearAllCache();
                await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
            } else if (saved?.state) {
                if (saved.state.networkMode !== undefined) {
                    networkMode = saved.state.networkMode;
                    updateNetworkModeUI();
                    await setNetworkMode(networkMode);
                }
                if (saved.state.images?.length && !urlChanged) {
                    images = saved.state.images;
                    // Restore UIDs if missing from saved state
                    images.forEach(i => { if(!i.uid) i.uid = ++uidCounter; else if(i.uid > uidCounter) uidCounter = i.uid; });
                    pageTitle = saved.state.pageTitle;
                    targetScrollPosition = saved.state.scrollPosition || 0;
                    dom.status.textContent = "Restored";
                    render();
                    return;
                }
            }
        } catch {}
        
        await setNetworkMode(networkMode);
        dom.status.textContent = "Scanning...";

        if (networkMode) {
            const netRes = await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}));
            addFoundImages(netRes?.images || []);
        } else {
            const [pageRes, cvsRes, netRes] = await Promise.all([
                browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(()=>({})),
                browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS" }).catch(()=>({})),
                browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}))
            ]);
            
            // Prefer content script title if available
            if (pageRes?.title) pageTitle = pageRes.title;
            
            addFoundImages([...(pageRes?.urls||[]), ...(cvsRes?.urls||[]), ...(netRes?.images||[])]);
        }
    } catch { dom.status.textContent = "Refresh page needed"; }
}
init().then(startAutoReload);

function updateUI(shouldSave = true) {
    const validImages = images.filter(i => !i.filtered && !i.sizeFiltered);
    const selected = validImages.filter(i => i.selected).length;
    dom.tracker.textContent = validImages.length === 0 ? "No images" : `${selected} / ${validImages.length}`;
    dom.toggleBtn.textContent = validImages.some(i => !i.selected) ? "Select All" : "Deselect All";
    dom.downloadBtn.disabled = dom.zipBtn.disabled = selected === 0;
    if (shouldSave) saveState();
}

function updateNetworkModeUI() {
    dom.networkToggle.textContent = networkMode ? "Network" : "Default";
    dom.networkToggle.classList.toggle('network-active', networkMode);
}

dom.grid.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const uid = parseInt(item.dataset.uid);
    const img = images.find(i => i.uid === uid);
    if (img) {
        img.selected = !img.selected;
        item.classList.toggle('selected', img.selected);
        updateUI(true);
    }
});

// Fast Toggle
dom.toggleBtn.onclick = () => {
    const validImages = images.filter(i => !i.filtered && !i.sizeFiltered);
    if (!validImages.length) return;
    const targetState = validImages.some(i => !i.selected);
    
    validImages.forEach(i => {
        i.selected = targetState;
        const item = document.getElementById(`item-${i.uid}`);
        if(item) item.classList.toggle('selected', targetState);
    });
    updateUI(true);
};

dom.renameToggle.onclick = () => {
    renameMode = !renameMode;
    dom.renameToggle.textContent = renameMode ? "Rename" : "Original";
    dom.renameToggle.classList.toggle('original-mode', !renameMode);
};

dom.networkToggle.onclick = async () => {
    clearAllCache();
    networkMode = !networkMode;
    updateNetworkModeUI();
    await setNetworkMode(networkMode);
    await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
    saveState(true);
    await init();
};

dom.sortBtn.onclick = () => {
    if (!sortOrder) { sortOrder = 'name_num'; dom.sortBtn.textContent = "Name 🔢"; }
    else if (sortOrder === 'name_num') { sortOrder = 'desc'; dom.sortBtn.textContent = "Size ⬇️"; }
    else if (sortOrder === 'desc') { sortOrder = 'asc'; dom.sortBtn.textContent = "Size ⬆️"; }
    else { sortOrder = null; dom.sortBtn.textContent = "Sort ⇅"; }
    
    // Defer sort to allow UI button update
    setTimeout(() => {
        if (sortOrder === 'name_num') images.sort((a,b)=>getFilename(a.url).localeCompare(getFilename(b.url), undefined, {numeric:true, sensitivity:'base'}));
        else if (sortOrder === 'desc') images.sort((a,b)=>(b.pixelCount||0)-(a.pixelCount||0));
        else if (sortOrder === 'asc') images.sort((a,b)=>(a.pixelCount||0)-(b.pixelCount||0));
        else images.sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
        performSort(); 
        saveState();
    }, 10);
};

dom.clearCache.onclick = () => {
    if (confirm('Clear all cached images?')) {
        clearAllCache(); render(); saveState(true);
        dom.status.textContent = "Cache cleared"; setTimeout(() => dom.status.textContent = "Ready", 2000);
    }
};

function addFoundImages(urls) {
    const currentIds = new Set(images.map(i => createImageIdentifier(i.url)));
    let added = 0;
    const startOrder = images.length > 0 ? Math.max(...images.map(i => i.sortOrder||0)) + 1 : 0;
    urls.forEach((url, idx) => {
        const id = createImageIdentifier(url);
        if (!currentIds.has(id)) {
            images.push({ url, displayUrl: url, selected: true, originalIndex: images.length + 1, sortOrder: startOrder + idx, uid: ++uidCounter });
            currentIds.add(id); added++;
        }
    });
    if (added > 0) {
        render(); saveState(); convertEssentialImages();
        dom.status.textContent = "Scan done"; setTimeout(() => { if(dom.status.textContent === "Scan done") dom.status.textContent = "Ready"; }, 2000);
    } else if (images.length === 0) {
        render();
        dom.status.textContent = "No images found";
    }
}

async function startAutoReload() {
    const loop = async () => {
        if (!currentTabId) return;
        if (await checkUrlChange()) {
            clearAllCache();
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            currentTabUrl = tab.url;
            await browser.runtime.sendMessage({ type: "CLEAR_TAB_STATE", tabId: currentTabId });
            await init();
            setTimeout(loop, 3500);
            return;
        }
        try {
            if (networkMode) {
                const netRes = await browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}));
                addFoundImages(netRes?.images || []);
            } else {
                const [p, c, n] = await Promise.all([
                    browser.tabs.sendMessage(currentTabId, { type: "SCAN_PAGE_ORDERED" }).catch(()=>({})),
                    browser.tabs.sendMessage(currentTabId, { type: "SCAN_CANVAS" }).catch(()=>({})),
                    browser.runtime.sendMessage({ type: "GET_NETWORK_IMAGES", tabId: currentTabId }).catch(()=>({}))
                ]);
                addFoundImages([...(p?.urls||[]), ...(c?.urls||[]), ...(n?.images||[])]);
            }
        } catch {}
        setTimeout(loop, 3500);
    };
    loop();
}

async function getBlobForDownload(img) {
    if (img.displayUrl.startsWith('data:')) return dataURItoBlob(img.displayUrl);
    try { return await (await fetch(img.url)).blob(); }
    catch {
        try { const res = await browser.tabs.sendMessage(currentTabId, { type: "CONVERT_IMAGE", url: img.url }); return res?.dataUrl ? dataURItoBlob(res.dataUrl) : null; }
        catch { return null; }
    }
}

dom.downloadBtn.onclick = async () => {
    const selected = images.filter(i => i.selected && !i.filtered && !i.sizeFiltered);
    if (!selected.length) return;
    dom.downloadBtn.disabled = true;
    const folder = (dom.folderName.value.trim().replace(/\/$/, "") || "").replace(/[^a-z0-9_-]/gi, "_").substring(0, 50);
    const list = sortOrder ? [...selected] : [...selected].sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
    
    try {
        for (let i = 0; i < list.length; i++) {
            if (i % 5 === 0) {
                dom.status.textContent = `Downloading ${i+1}/${list.length}...`;
                await new Promise(r => setTimeout(r, 0));
            }
            const blob = await getBlobForDownload(list[i]);
            if (blob) {
                let fname;
                if (renameMode) {
                    fname = (folder ? folder + '/' : '') + `image${String(images.indexOf(list[i])+1).padStart(3,'0')}.jpg`;
                    if (isAndroid) fname = fname.replace('/', '_');
                } else {
                    let oname = getFilename(list[i].url);
                    if (!oname.includes('.')) oname += ".jpg";
                    fname = (folder ? folder + (isAndroid?'_':'/') : '') + oname;
                }
                await triggerDownload(blob, fname);
                await new Promise(r => setTimeout(r, isAndroid ? 1800 : 200));
            }
        }
        dom.status.textContent = "Done!";
    } catch { dom.status.textContent = "Error"; }
    setTimeout(() => dom.status.textContent = "Ready", 2000);
    dom.downloadBtn.disabled = false;
};

dom.zipBtn.onclick = async () => {
    const selected = images.filter(i => i.selected && !i.filtered && !i.sizeFiltered);
    if (!selected.length) return;
    dom.zipBtn.disabled = true; dom.zipBtn.textContent = "Zipping...";
    const list = sortOrder ? [...selected] : [...selected].sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
    
    try {
        const zip = new JSZip(), used = new Set();
        for (let i = 0; i < list.length; i++) {
            if (i % 5 === 0) {
                dom.status.textContent = `Adding ${i+1}/${list.length}...`;
                await new Promise(r => setTimeout(r, 0));
            }
            const blob = await getBlobForDownload(list[i]);
            if (blob) {
                let fname;
                if (renameMode) {
                    fname = `image_${String(images.indexOf(list[i])+1).padStart(3,'0')}.jpg`;
                } else {
                    let oname = getFilename(list[i].url);
                    if (!oname.includes('.')) oname += ".jpg";
                    let final = oname, c = 1;
                    while(used.has(final)) {
                        const pt = oname.lastIndexOf('.');
                        final = pt !== -1 ? `${oname.substring(0,pt)}(${c})${oname.substring(pt)}` : `${oname}(${c})`;
                        c++;
                    }
                    used.add(final); fname = final;
                }
                zip.file(fname, blob);
            }
        }
        dom.status.textContent = "Compressing...";
        await new Promise(r => setTimeout(r, 0));
        const content = await zip.generateAsync({ type: "blob" });
        
        // ZIP NAME FIX: Robust sanitizer that keeps spaces and unicode
        let cleanTitle = pageTitle.replace(/[<>:"/\\|?*]/g, "").replace(/[\x00-\x1f]/g, "").trim();
        if (!cleanTitle) cleanTitle = "images";
        await triggerDownload(content, cleanTitle + ".zip");
        
        dom.status.textContent = "Saved!";
    } catch { dom.status.textContent = "Failed"; }
    dom.zipBtn.disabled = false; dom.zipBtn.textContent = "ZIP"; setTimeout(() => dom.status.textContent = "Ready", 2000);
};

async function triggerDownload(blob, filename) {
    if (isAndroid) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        await new Promise(r => setTimeout(r, 500));
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 30000);
    } else {
        const url = URL.createObjectURL(blob);
        try { await browser.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }); }
        catch { const a = document.createElement('a'); a.href = url; a.download = filename.split('/').pop(); document.body.appendChild(a); a.click(); document.body.removeChild(a); }
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
}

function dataURItoBlob(dataURI) {
    try {
        const split = dataURI.split(',');
        const bytes = atob(split[1]);
        const ia = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) ia[i] = bytes.charCodeAt(i);
        return new Blob([ia], {type: split[0].split(':')[1].split(';')[0]});
    } catch { return null; }
}

updateNetworkModeUI();
