const networkImageCache = new Map(), tabUrls = new Map(), popupState = new Map(), refererMap = new Map(), imageOrder = new Map();
let globalNetworkMode = 'default', activeTask = null;

const CDN_REGEX = new RegExp(['pstatic.net','webtoons.com','cloudinary.com','imgur.com','amazonaws.com','cloudfront.net','akamaized.net','fastly.net','cdn','images','img','static','media','assets','photos','googleusercontent.com','gstatic.com','twimg.com','fbcdn.net','pinimg.com','shopify.com','wordpress.com','wixstatic.com','unsplash.com','pexels.com','giphy.com','tenor.com'].join('|').replace(/\./g, '\\.'), 'i');
const COMMON_CDN_REGEX = new RegExp(['pstatic.net','webtoons.com','cloudinary.com','imgur.com','gstatic.com','googleusercontent.com'].join('|').replace(/\./g, '\\.'), 'i');
const imgExtRegex = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|jfif)(\?|$)/i;

browser.storage.local.get('networkMode', res => { if (res?.networkMode) globalNetworkMode = res.networkMode; });
browser.runtime.setUninstallURL("https://ozler365.github.io/ozler-s-works-info/#/issues");
browser.runtime.onInstalled.addListener(details => { if (details.reason === "install") browser.tabs.create({ url: "https://ozler365.github.io/ozler-s-works-info/#/home" }); });

function cleanupTab(tabId) {
    networkImageCache.delete(tabId); tabUrls.delete(tabId); popupState.delete(tabId); imageOrder.delete(tabId);
}

browser.tabs.onRemoved.addListener(cleanupTab);
browser.tabs.onActivated.addListener(activeInfo => cleanupTab(activeInfo.tabId));
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) cleanupTab(tabId);
    if (changeInfo.url) {
        try { tabUrls.set(tabId, { url: changeInfo.url, origin: new URL(changeInfo.url).origin }); }
        catch { tabUrls.set(tabId, { url: changeInfo.url, origin: "" }); }
    }
});

function isImageFromCurrentPage(imageUrl, pageData, networkMode = false) {
    if (!pageData) return networkMode;
    try {
        const urlLower = imageUrl.toLowerCase();
        if (networkMode) return CDN_REGEX.test(urlLower) || imgExtRegex.test(imageUrl);
        if (pageData.origin && imageUrl.startsWith(pageData.origin)) return true;
        if (new URL(imageUrl).origin === pageData.origin) return true;
        return COMMON_CDN_REGEX.test(urlLower);
    } catch { return networkMode; }
}

function addImageToCache(tabId, url, mode = 'default') {
    let caches = networkImageCache.get(tabId);
    if (!caches) {
        caches = { default: new Set(), network: new Set(), blob: new Set() };
        networkImageCache.set(tabId, caches);
    }
    const targetSet = caches[mode] || caches.default;
    if (!targetSet.has(url) && targetSet.size < 2000) {
        targetSet.add(url);
        let orderMap = imageOrder.get(tabId);
        if (!orderMap) { orderMap = new Map(); imageOrder.set(tabId, orderMap); }
        if (!orderMap.has(url)) orderMap.set(url, orderMap.size);
    }
}

browser.webRequest.onCompleted.addListener(
    (details) => {
        if (details.statusCode !== 200) return;
        const isNetworkMode = (globalNetworkMode === 'network' || globalNetworkMode === true);
        if (!isNetworkMode && details.type !== 'image') return;
        
        if (details.responseHeaders) {
            const lenHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
            if (lenHeader && parseInt(lenHeader.value, 10) < 1024) return;
        }

        const tabsToCheck = details.tabId !== -1 ? [details.tabId] : Array.from(tabUrls.keys());
        for (const tId of tabsToCheck) {
            let imageUrl = details.url;
            if (details.type !== 'image') {
                const typeHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type');
                if (!typeHeader) return;
                const contentType = typeHeader.value.toLowerCase();
                if (!contentType.startsWith('image/') && !contentType.includes('application/octet-stream')) return;
            }
            const pageData = tabUrls.get(tId);
            if (pageData && isImageFromCurrentPage(imageUrl, pageData, isNetworkMode)) {
                addImageToCache(tId, imageUrl, isNetworkMode ? 'network' : (globalNetworkMode === 'blob' ? 'blob' : 'default'));
            }
        }
    },
    { urls: ["<all_urls>"], types: ["image","xmlhttprequest","other","main_frame","sub_frame","object","media"] },
    ["responseHeaders"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const referer = refererMap.get(details.url);
        if (referer) {
            const headers = details.requestHeaders;
            const refIdx = headers.findIndex(h => h.name.toLowerCase() === "referer");
            if (refIdx !== -1) headers[refIdx].value = referer;
            else headers.push({ name: "Referer", value: referer });
            return { requestHeaders: headers };
        }
    },
    { urls: ["<all_urls>"] },
    ["blocking", "requestHeaders"]
);

async function bgGetBlob(item, tabId) {
    if (item.displayUrl && item.displayUrl.startsWith('data:')) return await fetch(item.displayUrl).then(r => r.blob()).catch(()=>null);
    try { return await fetch(item.url).then(r=>r.blob()); }
    catch {
        if (tabId) {
            try {
                const res = await browser.tabs.sendMessage(tabId, { type: "CONVERT_IMAGE", url: item.url });
                if (res?.dataUrl) return await fetch(res.dataUrl).then(r=>r.blob());
            } catch {}
        }
    }
    return null;
}

async function triggerBgDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    try { await browser.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }); } catch (e) { }
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function processTask(items, options, tabId) {
    const { renameMode, folder, isAndroid, pageTitle } = options;
    try {
        if (activeTask.type === 'zip') {
            const zip = new JSZip(), used = new Set();
            for (let i = 0; i < items.length; i++) {
                if (activeTask.cancel) break;
                activeTask.done = i; activeTask.statusText = `Adding ${i+1}/${items.length}...`;
                const blob = await bgGetBlob(items[i], tabId);
                if (blob) {
                    let fname = renameMode ? `image_${String(items[i].originalIndex+1).padStart(3,'0')}.jpg` : items[i]._name + (items[i]._name.includes('.') ? '' : '.jpg');
                    if (!renameMode) { let final = fname, c = 1; while(used.has(final)) { const pt = fname.lastIndexOf('.'); final = pt !== -1 ? `${fname.substring(0,pt)}(${c})${fname.substring(pt)}` : `${fname}(${c})`; c++; } used.add(final); fname = final; }
                    zip.file(fname, blob);
                }
            }
            if (activeTask.cancel) { activeTask = null; return; }
            activeTask.statusText = "Compressing...";
            const content = await zip.generateAsync({ type: "blob" });
            if (activeTask.cancel) { activeTask = null; return; }
            let cleanTitle = (pageTitle || "images").replace(/[<>:"/\\|?*]/g, "").replace(/[\x00-\x1f]/g, "").trim() || "images";
            await triggerBgDownload(content, cleanTitle + ".zip");
        } else {
            for (let i = 0; i < items.length; i++) {
                if (activeTask.cancel) break;
                activeTask.done = i; activeTask.statusText = `Downloading ${i+1}/${items.length}...`;
                const blob = await bgGetBlob(items[i], tabId);
                if (blob) {
                    let fname = renameMode ? (folder ? folder + '/' : '') + `image${String(items[i].originalIndex+1).padStart(3,'0')}.jpg` : (folder ? folder + '/' : '') + items[i]._name + (items[i]._name.includes('.') ? '' : '.jpg');
                    if (isAndroid) fname = fname.replace(/\//g, '_');
                    await triggerBgDownload(blob, fname);
                    await new Promise(r => setTimeout(r, isAndroid ? 1800 : 200));
                }
            }
        }
        if (!activeTask.cancel) activeTask.statusText = "Done!";
    } catch { if (activeTask) activeTask.statusText = "Error"; }
    setTimeout(() => { if (activeTask && (activeTask.statusText === "Done!" || activeTask.statusText === "Error" || activeTask.cancel)) activeTask = null; }, 3000);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, tabId } = message;
    switch (type) {
        case "DOM_IMAGES_DISCOVERED":
            if (globalNetworkMode === 'default' && sender.tab?.id !== undefined && message.urls?.length) {
                for (let i = 0; i < message.urls.length; i++) {
                    const url = message.urls[i];
                    if (!url || url.startsWith('data:') || url.startsWith('blob:') || /\/(1x1|pixel|tracker|beacon)\./i.test(url)) continue;
                    addImageToCache(sender.tab.id, url, 'default');
                }
            }
            sendResponse({ ok: true }); break;
        case "GET_NETWORK_IMAGES":
            const reqMode = (globalNetworkMode === 'network' || globalNetworkMode === true) ? 'network' : (globalNetworkMode === 'blob' ? 'blob' : 'default');
            let images = Array.from(networkImageCache.get(tabId)?.[reqMode] || []);
            const orderMap = imageOrder.get(tabId);
            if (orderMap) images.sort((a, b) => (orderMap.get(a) ?? Infinity) - (orderMap.get(b) ?? Infinity));
            sendResponse({ images }); break;
        case "SET_NETWORK_MODE":
            browser.storage.local.set({ networkMode: globalNetworkMode = message.networkMode });
            sendResponse({ success: true }); break;
        case "GET_CURRENT_TAB_MODE":
            sendResponse({ mode: globalNetworkMode }); break;
        case "UPDATE_IMAGE_STATE":
            const target = popupState.get(tabId)?.images?.find(i => i.uid === message.uid);
            if (target) target.unscrambledUrl = target.displayUrl = message.displayUrl;
            sendResponse({ success: true }); break;
        case "SAVE_STATE":
            popupState.set(tabId, message.state);
            if (message.state?.networkMode !== undefined) browser.storage.local.set({ networkMode: globalNetworkMode = message.state.networkMode });
            if (message.state?.tabUrl) {
                try { tabUrls.set(tabId, { url: message.state.tabUrl, origin: new URL(message.state.tabUrl).origin }); } 
                catch { tabUrls.set(tabId, { url: message.state.tabUrl, origin: "" }); }
            }
            sendResponse({ success: true }); break;
        case "GET_STATE":
            sendResponse({ state: { ...(popupState.get(tabId) || {}), networkMode: globalNetworkMode } }); break;
        case "CLEAR_TAB_STATE":
            cleanupTab(tabId); sendResponse({ success: true }); break;
        case "FETCH_IMAGE_BLOB":
            const { url } = message, pData = tabUrls.get(tabId);
            if (pData) refererMap.set(url, pData.url);
            fetch(url).then(r => r.ok ? r.blob() : Promise.reject()).then(blob => {
                if (pData) setTimeout(() => refererMap.delete(url), 2000);
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                reader.onerror = () => sendResponse({ error: true });
                reader.readAsDataURL(blob);
            }).catch(() => { if (pData) refererMap.delete(url); sendResponse({ error: true }); });
            return true;
        case "START_DOWNLOAD":
        case "START_ZIP":
            activeTask = { type: type === "START_ZIP" ? 'zip' : 'download', total: message.items.length, done: 0, cancel: false, statusText: "Starting..." };
            processTask(message.items, message.options, tabId);
            sendResponse({ success: true }); break;
        case "STOP_TASK":
            if (activeTask) activeTask.cancel = true; sendResponse({ success: true }); break;
        case "GET_TASK_PROGRESS":
            sendResponse({ task: activeTask }); break;
    }
});

browser.webRequest.onHeadersReceived.addListener(
    (details) => {
        const headers = details.responseHeaders.filter(h => !['access-control-allow-origin','content-security-policy'].includes(h.name.toLowerCase()));
        headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
        return { responseHeaders: headers };
    },
    { urls: ["<all_urls>"], types: ["image","media"] }, ["blocking", "responseHeaders"]
);
