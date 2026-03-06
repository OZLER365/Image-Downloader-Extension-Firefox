importScripts('jszip.min.js');
globalThis.browser = chrome;

const networkImageCache = new Map();
const tabUrls = new Map();
const popupState = new Map();
const imageOrder = new Map();
const unassignedNetworkImages = new Set();
let globalNetworkMode = 'default';
let dnrRuleIdCounter = 100;

let dlState = { active: false, items: [], currentIndex: 0, tabId: null, isAndroid: false, type: 'single', zipFilename: 'images.zip', zipInstance: null };

let isRestoring = true;
let pendingCacheAdds = [];

const COMMON_CDN_REGEX = /pstatic\.net|webtoons\.com|cloudinary\.com|imgur\.com|gstatic\.com|googleusercontent\.com/i;
const imgExtRegex = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|jfif)(\?|#|$)/i;

chrome.storage.local.get(['networkMode', 'networkImageCache', 'imageOrder', 'popupState', 'tabUrls'], (res) => {
    if (res.networkMode) globalNetworkMode = res.networkMode;
    if (res.networkImageCache) {
        for (const [tabId, caches] of Object.entries(res.networkImageCache)) {
            networkImageCache.set(parseInt(tabId), {
                default: new Set(caches.default || []),
                network: new Set(caches.network || []),
                blob: new Set(caches.blob || [])
            });
        }
    }
    if (res.imageOrder) {
        for (const [tabId, orders] of Object.entries(res.imageOrder))
            imageOrder.set(parseInt(tabId), new Map(Object.entries(orders)));
    }
    if (res.popupState) {
        for (const [tabId, state] of Object.entries(res.popupState))
            popupState.set(parseInt(tabId), state);
    }
    if (res.tabUrls) {
        for (const [tabId, data] of Object.entries(res.tabUrls))
            tabUrls.set(parseInt(tabId), data);
    }

    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            if (tab.url && !tabUrls.has(tab.id)) {
                try { tabUrls.set(tab.id, { url: tab.url, origin: new URL(tab.url).origin }); }
                catch { tabUrls.set(tab.id, { url: tab.url, origin: "" }); }
            }
        }
        isRestoring = false;
        for (const item of pendingCacheAdds) addImageToCache(item.tabId, item.url, item.mode, true);
        pendingCacheAdds = [];
    });
});

const MAX_IMAGES_PER_TAB = 500;

function trimCacheToQuota() {
    for (const [tabId, caches] of networkImageCache.entries()) {
        for (const mode of ['default', 'network', 'blob']) {
            const set = caches[mode];
            if (set && set.size > MAX_IMAGES_PER_TAB) {
                const orderMap = imageOrder.get(tabId);
                const sorted = Array.from(set).sort((a, b) => {
                    const ao = orderMap ? (orderMap.get(a) ?? Infinity) : Infinity;
                    const bo = orderMap ? (orderMap.get(b) ?? Infinity) : Infinity;
                    return ao - bo;
                });
                caches[mode] = new Set(sorted.slice(-MAX_IMAGES_PER_TAB));
            }
        }
    }
}

function buildPersistPayload() {
    const cacheObj = {}, orderObj = {}, stateObj = {}, urlObj = {};
    for (const [tabId, caches] of networkImageCache.entries())
        cacheObj[tabId] = { default: Array.from(caches.default), network: Array.from(caches.network), blob: Array.from(caches.blob) };
    for (const [tabId, orders] of imageOrder.entries())
        orderObj[tabId] = Object.fromEntries(orders);
    for (const [tabId, state] of popupState.entries())
        stateObj[tabId] = state;
    for (const [tabId, data] of tabUrls.entries())
        urlObj[tabId] = data;
    return { networkImageCache: cacheObj, imageOrder: orderObj, popupState: stateObj, tabUrls: urlObj };
}

function persistCache() {
    clearTimeout(persistCache.timer);
    persistCache.timer = setTimeout(() => {
        chrome.storage.local.set(buildPersistPayload(), () => {
            if (chrome.runtime.lastError) {
                const msg = chrome.runtime.lastError.message || '';
                if (msg.includes('QuotaBytes') || msg.includes('quota')) {
                    trimCacheToQuota();
                    chrome.storage.local.clear(() => {
                        chrome.storage.local.set(buildPersistPayload(), () => {
                            if (chrome.runtime.lastError) console.warn('[ImageDL] Storage quota exceeded.');
                        });
                    });
                }
            }
        });
    }, 800);
}

chrome.runtime.setUninstallURL("https://ozler365.github.io/ozler-s-works-info/#/issues");

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") chrome.tabs.create({ url: "https://ozler365.github.io/ozler-s-works-info/#/home" });
    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1],
        addRules: [{
            id: 1, priority: 1,
            action: { type: "modifyHeaders", responseHeaders: [{ header: "Access-Control-Allow-Origin", operation: "set", value: "*" }] },
            condition: { resourceTypes: ["image", "media"] }
        }]
    });
});

function cleanupTab(tabId) {
    networkImageCache.delete(tabId); tabUrls.delete(tabId); popupState.delete(tabId); imageOrder.delete(tabId);
    persistCache();
}

chrome.tabs.onRemoved.addListener(cleanupTab);
chrome.tabs.onActivated.addListener((activeInfo) => cleanupTab(activeInfo.tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
        cleanupTab(tabId);
        try { tabUrls.set(tabId, { url: changeInfo.url, origin: new URL(changeInfo.url).origin }); }
        catch { tabUrls.set(tabId, { url: changeInfo.url, origin: "" }); }
        persistCache();
    }
});

// Simplified: networkMode short-circuits immediately; no redundant double-check
function isImageFromCurrentPage(imageUrl, pageData, networkMode = false) {
    if (!pageData) return networkMode;
    if (networkMode) return true;
    try {
        if (pageData.origin && imageUrl.startsWith(pageData.origin)) return true;
        if (new URL(imageUrl).origin === pageData.origin) return true;
        if (COMMON_CDN_REGEX.test(imageUrl)) return true;
    } catch {}
    return false;
}

function addImageToCache(tabId, url, mode = 'default', bypassRestoreCheck = false) {
    if (isRestoring && !bypassRestoreCheck) { pendingCacheAdds.push({ tabId, url, mode }); return; }
    let caches = networkImageCache.get(tabId);
    if (!caches) { caches = { default: new Set(), network: new Set(), blob: new Set() }; networkImageCache.set(tabId, caches); }
    const targetSet = caches[mode] || caches.default;
    if (!targetSet.has(url) && targetSet.size < 2000) {
        targetSet.add(url);
        let orderMap = imageOrder.get(tabId);
        if (!orderMap) { orderMap = new Map(); imageOrder.set(tabId, orderMap); }
        if (!orderMap.has(url)) orderMap.set(url, orderMap.size);
        persistCache();
    }
}

chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.statusCode !== 200 && details.statusCode !== 304 && details.statusCode !== 206 && details.statusCode !== 0) return;
        const isNetworkMode = (globalNetworkMode === 'network' || globalNetworkMode === true);
        if (!isNetworkMode && details.type !== 'image') return;

        if (details.responseHeaders) {
            const lenHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
            if (lenHeader && parseInt(lenHeader.value, 10) < 10) return;
        }

        let tabsToCheck = [];
        if (details.tabId !== -1) {
            tabsToCheck = [details.tabId];
        } else {
            if (details.initiator) {
                for (const [id, data] of tabUrls.entries()) {
                    if (data.origin === details.initiator || data.url.startsWith(details.initiator)) tabsToCheck.push(id);
                }
            }
            if (tabsToCheck.length === 0) tabsToCheck = Array.from(tabUrls.keys());
        }

        const imageUrl = details.url;
        let isVerifiedImage = details.type === 'image';

        if (!isVerifiedImage) {
            const typeHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type');
            let isValidType = false;
            if (typeHeader) {
                const ct = typeHeader.value.toLowerCase();
                if (ct.startsWith('image/') || ct.includes('application/octet-stream') || ct.includes('binary/octet-stream') || ct.includes('application/x-binary')) {
                    isValidType = true; isVerifiedImage = true;
                }
            }
            if (!isValidType && isNetworkMode && imgExtRegex.test(imageUrl)) isValidType = true;
            if (!isValidType) return;
        }

        if (tabsToCheck.length === 0 && isNetworkMode) {
            unassignedNetworkImages.add(imageUrl);
            if (unassignedNetworkImages.size > 200) unassignedNetworkImages.delete(unassignedNetworkImages.values().next().value);
            return;
        }

        for (const tId of tabsToCheck) {
            let pageData = tabUrls.get(tId);
            if (!pageData && details.initiator) pageData = { url: details.initiator, origin: details.initiator };
            if (isNetworkMode) addImageToCache(tId, imageUrl, 'network');
            else if (pageData && isImageFromCurrentPage(imageUrl, pageData, false)) addImageToCache(tId, imageUrl, globalNetworkMode === 'blob' ? 'blob' : 'default');
        }
    },
    { urls: ["<all_urls>"], types: ["image", "xmlhttprequest", "other", "main_frame", "sub_frame", "object", "media"] },
    ["responseHeaders"]
);

async function processNextDownload() {
    if (!dlState.active) {
        chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", dlType: dlState.type, status: "Stopped", active: false }).catch(() => {});
        return;
    }

    const tabExists = await chrome.tabs.get(dlState.tabId).catch(() => null);
    if (!tabExists) {
        dlState.active = false;
        chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", dlType: dlState.type, status: "Source tab closed. Stopped.", active: false }).catch(() => {});
        return;
    }

    if (dlState.currentIndex >= dlState.items.length) {
        if (dlState.type === 'zip' && dlState.zipInstance) {
            chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", dlType: "zip", status: "Compressing...", active: true }).catch(() => {});
            dlState.zipInstance.generateAsync({ type: "base64" }).then(async base64Content => {
                const dataUrl = "data:application/zip;base64," + base64Content;
                if (dlState.isAndroid) {
                    chrome.tabs.sendMessage(dlState.tabId, { type: "EXECUTE_ANDROID_DOWNLOAD", dataUrl, filename: dlState.zipFilename }).catch(() => {});
                } else {
                    chrome.downloads.download({ url: dataUrl, filename: dlState.zipFilename, saveAs: false, conflictAction: "uniquify" });
                }
                dlState.active = false;
                dlState.zipInstance = null;
                chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", dlType: "zip", status: "Done!", active: false }).catch(() => {});
            }).catch(() => {
                dlState.active = false;
                chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", dlType: "zip", status: "Failed", active: false }).catch(() => {});
            });
        } else {
            dlState.active = false;
            chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", dlType: "single", status: "Done!", active: false }).catch(() => {});
        }
        return;
    }

    const item = dlState.items[dlState.currentIndex];
    chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", dlType: dlState.type, current: dlState.currentIndex, total: dlState.items.length, active: true }).catch(() => {});

    try {
        let dataUri = null;
        if (item.displayUrl && item.displayUrl.startsWith('data:')) {
            dataUri = item.displayUrl;
        } else {
            const targetUrl = (item.displayUrl && item.displayUrl.startsWith('blob:')) ? item.displayUrl : item.url;
            try {
                const res = await chrome.tabs.sendMessage(dlState.tabId, { type: "FETCH_AND_CONVERT", url: targetUrl });
                if (res && res.dataUrl) dataUri = res.dataUrl;
            } catch {}
        }

        if (dlState.type === 'zip') {
            let blob = null;
            try { blob = await (await fetch(dataUri || item.url)).blob(); } catch {}
            if (blob) dlState.zipInstance.file(item.filename, blob);
        } else {
            if (dlState.isAndroid) {
                await chrome.tabs.sendMessage(dlState.tabId, { type: "EXECUTE_ANDROID_DOWNLOAD", dataUrl: dataUri || item.url, filename: item.filename }).catch(() => {});
            } else {
                await new Promise(resolve => {
                    chrome.downloads.download({ url: dataUri || item.url, filename: item.filename, saveAs: false, conflictAction: "uniquify" }, () => resolve());
                });
            }
            await new Promise(r => setTimeout(r, dlState.isAndroid ? 1800 : 200));
        }
    } catch {}

    dlState.currentIndex++;
    processNextDownload();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, tabId } = message;
    switch (type) {
        case "START_DOWNLOAD":
            dlState = {
                active: true, items: message.items, currentIndex: 0, tabId: message.tabId,
                isAndroid: message.isAndroid, type: message.dlType || 'single',
                zipFilename: message.zipFilename || 'images.zip',
                zipInstance: message.dlType === 'zip' ? new JSZip() : null
            };
            processNextDownload();
            sendResponse({ success: true }); break;
        case "STOP_DOWNLOAD":
            dlState.active = false;
            sendResponse({ success: true }); break;
        case "GET_DOWNLOAD_STATUS":
            sendResponse(dlState); break;
        case "DOM_IMAGES_DISCOVERED":
            if (globalNetworkMode === 'default') {
                const tabIdForDom = sender.tab ? sender.tab.id : null;
                if (tabIdForDom !== null && message.urls && message.urls.length) {
                    for (const url of message.urls) {
                        if (!url || url.startsWith('data:') || url.startsWith('blob:')) continue;
                        if (/\/(1x1|pixel|tracker|beacon)\./i.test(url)) continue;
                        addImageToCache(tabIdForDom, url, 'default');
                    }
                }
            }
            sendResponse({ ok: true }); break;
        case "GET_NETWORK_IMAGES": {
            const sendImages = () => {
                const reqMode = (globalNetworkMode === 'network' || globalNetworkMode === true) ? 'network' : (globalNetworkMode === 'blob' ? 'blob' : 'default');
                let imgs = [];
                const caches = networkImageCache.get(tabId);
                if (caches && caches[reqMode]) imgs = Array.from(caches[reqMode]);
                if (reqMode === 'network' && unassignedNetworkImages.size > 0) imgs.push(...unassignedNetworkImages);
                const orderMap = imageOrder.get(tabId);
                if (orderMap) imgs.sort((a, b) => (orderMap.get(a) ?? Infinity) - (orderMap.get(b) ?? Infinity));
                sendResponse({ images: imgs });
            };
            if (isRestoring) {
                const checkRestore = setInterval(() => { if (!isRestoring) { clearInterval(checkRestore); sendImages(); } }, 50);
                return true;
            }
            sendImages();
            break;
        }
        case "SET_NETWORK_MODE":
            globalNetworkMode = message.networkMode;
            chrome.storage.local.set({ networkMode: globalNetworkMode });
            sendResponse({ success: true }); break;
        case "GET_CURRENT_TAB_MODE":
            sendResponse({ mode: globalNetworkMode }); break;
        case "SAVE_STATE":
            popupState.set(tabId, message.state);
            if (message.state?.tabUrl) {
                try { tabUrls.set(tabId, { url: message.state.tabUrl, origin: new URL(message.state.tabUrl).origin }); }
                catch { tabUrls.set(tabId, { url: message.state.tabUrl, origin: "" }); }
            }
            persistCache();
            sendResponse({ success: true }); break;
        case "GET_STATE": {
            const sendState = () => {
                const state = popupState.get(tabId) || {};
                state.networkMode = globalNetworkMode;
                sendResponse({ state });
            };
            if (isRestoring) {
                const checkRestore = setInterval(() => { if (!isRestoring) { clearInterval(checkRestore); sendState(); } }, 50);
                return true;
            }
            sendState();
            break;
        }
        case "CLEAR_TAB_STATE":
            cleanupTab(tabId); unassignedNetworkImages.clear(); sendResponse({ success: true }); break;
        case "FETCH_IMAGE_BLOB": {
            const pData = tabUrls.get(tabId);
            const ruleId = dnrRuleIdCounter++;
            if (pData) {
                chrome.declarativeNetRequest.updateDynamicRules({
                    removeRuleIds: [ruleId],
                    addRules: [{ id: ruleId, priority: 2, action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: pData.url }] }, condition: { urlFilter: message.url, resourceTypes: ["xmlhttprequest"] } }]
                });
            }
            fetch(message.url).then(r => r.ok ? r.blob() : Promise.reject())
                .then(blob => {
                    if (pData) setTimeout(() => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] }), 2000);
                    const reader = new FileReader();
                    reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                    reader.onerror = () => sendResponse({ error: true });
                    reader.readAsDataURL(blob);
                }).catch(() => {
                    if (pData) chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
                    sendResponse({ error: true });
                });
            return true;
        }
    }
});
