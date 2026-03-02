const networkImageCache = new Map();
const tabUrls = new Map();
const popupState = new Map(); 
const refererMap = new Map();
const imageOrder = new Map();
let globalNetworkMode = 'default';

// Pre-compiled Regexes are exponentially faster than Array iteration (.includes) on every single network request.
const CDN_REGEX = new RegExp(['pstatic.net','webtoons.com','cloudinary.com','imgur.com','amazonaws.com','cloudfront.net','akamaized.net','fastly.net','cdn','images','img','static','media','assets','photos','googleusercontent.com','gstatic.com','twimg.com','fbcdn.net','pinimg.com','shopify.com','wordpress.com','wixstatic.com','unsplash.com','pexels.com','giphy.com','tenor.com'].join('|').replace(/\./g, '\\.'), 'i');
const COMMON_CDN_REGEX = new RegExp(['pstatic.net','webtoons.com','cloudinary.com','imgur.com','gstatic.com','googleusercontent.com'].join('|').replace(/\./g, '\\.'), 'i');
const imgExtRegex = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|jfif)(\?|$)/i;

browser.storage.local.get('networkMode', (res) => {
    if (res && res.networkMode) globalNetworkMode = res.networkMode;
});

browser.runtime.setUninstallURL("https://ozler365.github.io/ozler-s-works-info/#/issues");

browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") browser.tabs.create({ url: "https://ozler365.github.io/ozler-s-works-info/#/home" });
});

function cleanupTab(tabId) {
    networkImageCache.delete(tabId);
    tabUrls.delete(tabId);
    popupState.delete(tabId);
    imageOrder.delete(tabId);
}

browser.tabs.onRemoved.addListener(cleanupTab);
browser.tabs.onActivated.addListener((activeInfo) => cleanupTab(activeInfo.tabId));

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) cleanupTab(tabId);
    if (changeInfo.url) {
        try {
            tabUrls.set(tabId, { url: changeInfo.url, origin: new URL(changeInfo.url).origin });
        } catch {
            tabUrls.set(tabId, { url: changeInfo.url, origin: "" });
        }
    }
});

function isImageFromCurrentPage(imageUrl, pageData, networkMode = false) {
    if (!pageData) return networkMode;
    try {
        const urlLower = imageUrl.toLowerCase();
        if (networkMode) {
            if (CDN_REGEX.test(urlLower) || imgExtRegex.test(imageUrl)) return true;
        } else {
            if (pageData.origin && imageUrl.startsWith(pageData.origin)) return true;
            if (new URL(imageUrl).origin === pageData.origin) return true;
            if (COMMON_CDN_REGEX.test(urlLower)) return true;
        }
    } catch {}
    return networkMode;
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
        if (!orderMap) {
            orderMap = new Map();
            imageOrder.set(tabId, orderMap);
        }
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
            let hasReferer = false;
            for (let i = 0; i < headers.length; i++) {
                if (headers[i].name.toLowerCase() === "referer") {
                    headers[i].value = referer;
                    hasReferer = true;
                    break;
                }
            }
            if (!hasReferer) headers.push({ name: "Referer", value: referer });
            return { requestHeaders: headers };
        }
    },
    { urls: ["<all_urls>"] },
    ["blocking", "requestHeaders"]
);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, tabId } = message;
    switch (type) {
        case "DOM_IMAGES_DISCOVERED":
            if (globalNetworkMode === 'default') {
                const tabIdForDom = sender.tab ? sender.tab.id : null;
                if (tabIdForDom !== null && message.urls && message.urls.length) {
                    for (let i = 0; i < message.urls.length; i++) {
                        const url = message.urls[i];
                        if (!url || url.startsWith('data:') || url.startsWith('blob:')) continue;
                        if (/\/(1x1|pixel|tracker|beacon)\./i.test(url)) continue;
                        addImageToCache(tabIdForDom, url, 'default');
                    }
                }
            }
            sendResponse({ ok: true });
            break;
        case "GET_NETWORK_IMAGES":
            const reqMode = (globalNetworkMode === 'network' || globalNetworkMode === true) ? 'network' : (globalNetworkMode === 'blob' ? 'blob' : 'default');
            let images = [];
            const caches = networkImageCache.get(tabId);
            if (caches && caches[reqMode]) images = Array.from(caches[reqMode]);
            const orderMap = imageOrder.get(tabId);
            if (orderMap) images.sort((a, b) => (orderMap.get(a) ?? Infinity) - (orderMap.get(b) ?? Infinity));
            sendResponse({ images });
            break;
        case "SET_NETWORK_MODE":
            globalNetworkMode = message.networkMode;
            browser.storage.local.set({ networkMode: globalNetworkMode });
            sendResponse({ success: true });
            break;
        case "GET_CURRENT_TAB_MODE":
            sendResponse({ mode: globalNetworkMode });
            break;
        case "SAVE_STATE":
            popupState.set(tabId, message.state);
            if (message.state?.networkMode !== undefined) {
                 globalNetworkMode = message.state.networkMode;
                 browser.storage.local.set({ networkMode: globalNetworkMode });
            }
            if (message.state?.tabUrl) {
                try { tabUrls.set(tabId, { url: message.state.tabUrl, origin: new URL(message.state.tabUrl).origin }); } 
                catch { tabUrls.set(tabId, { url: message.state.tabUrl, origin: "" }); }
            }
            sendResponse({ success: true });
            break;
        case "GET_STATE":
            let state = popupState.get(tabId) || {};
            state.networkMode = globalNetworkMode;
            sendResponse({ state });
            break;
        case "CLEAR_TAB_STATE":
            cleanupTab(tabId);
            sendResponse({ success: true });
            break;
        case "FETCH_IMAGE_BLOB":
            const { url } = message;
            const pData = tabUrls.get(tabId);
            if (pData) refererMap.set(url, pData.url);
            fetch(url).then(r => r.ok ? r.blob() : Promise.reject())
            .then(blob => {
                if (pData) setTimeout(() => refererMap.delete(url), 2000);
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                reader.onerror = () => sendResponse({ error: true });
                reader.readAsDataURL(blob);
            }).catch(() => {
                if (pData) refererMap.delete(url);
                sendResponse({ error: true });
            });
            return true;
    }
});

browser.webRequest.onHeadersReceived.addListener(
    (details) => {
        const headers = details.responseHeaders.filter(h => !['access-control-allow-origin','content-security-policy'].includes(h.name.toLowerCase()));
        headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
        return { responseHeaders: headers };
    },
    { urls: ["<all_urls>"], types: ["image","media"] }, 
    ["blocking", "responseHeaders"]
);
