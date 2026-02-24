const networkImageCache = new Map();
const tabUrls = new Map();
const popupState = new Map(); 
const refererMap = new Map();
const imageOrder = new Map();
let globalNetworkMode = 'default';

const CDN_WHITELIST = new Set(['pstatic.net','webtoons.com','cloudinary.com','imgur.com','amazonaws.com','cloudfront.net','akamaized.net','fastly.net','cdn','images','img','static','media','assets','photos','googleusercontent.com','gstatic.com','twimg.com','fbcdn.net','pinimg.com','shopify.com','wordpress.com','wixstatic.com','unsplash.com','pexels.com','giphy.com','tenor.com']);
const COMMON_CDNS = ['pstatic.net','webtoons.com','cloudinary.com','imgur.com','gstatic.com','googleusercontent.com'];

browser.storage.local.get('networkMode', (res) => {
    if (res && res.networkMode) globalNetworkMode = res.networkMode;
});

browser.runtime.setUninstallURL("https://ozler365.github.io/ozler-s-works-info/#/issues");

browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") browser.tabs.create({ url: "https://ozler365.github.io/ozler-s-works-info/#/home" });
});

browser.tabs.onRemoved.addListener((tabId) => {
    networkImageCache.delete(tabId);
    tabUrls.delete(tabId);
    popupState.delete(tabId);
    imageOrder.delete(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        networkImageCache.delete(tabId);
        popupState.delete(tabId);
        imageOrder.delete(tabId);
    }
    if (changeInfo.url) tabUrls.set(tabId, changeInfo.url);
});

function isImageFromCurrentPage(imageUrl, pageUrl, networkMode = false) {
    if (!pageUrl) return networkMode;
    try {
        const urlLower = imageUrl.toLowerCase();
        if (networkMode) {
            for (const cdn of CDN_WHITELIST) if (urlLower.includes(cdn)) return true;
            if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|jfif)(\?|$)/i.test(imageUrl)) return true;
        } else {
            if (new URL(imageUrl).origin === new URL(pageUrl).origin) return true;
            for (const cdn of COMMON_CDNS) if (urlLower.includes(cdn)) return true;
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
        const networkMode = globalNetworkMode;
        const isNetworkMode = (networkMode === 'network' || networkMode === true);
        
        if (!isNetworkMode && details.type !== 'image') return;
        
        if (details.responseHeaders) {
            const lenHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
            if (lenHeader && parseInt(lenHeader.value) < 1024) return;
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
            const pageUrl = tabUrls.get(tId);
            if (pageUrl && isImageFromCurrentPage(imageUrl, pageUrl, isNetworkMode)) {
                addImageToCache(tId, imageUrl, isNetworkMode ? 'network' : (networkMode === 'blob' ? 'blob' : 'default'));
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
            if (message.state?.tabUrl) tabUrls.set(tabId, message.state.tabUrl);
            sendResponse({ success: true });
            break;
        case "GET_STATE":
            let state = popupState.get(tabId) || {};
            state.networkMode = globalNetworkMode;
            sendResponse({ state });
            break;
        case "CLEAR_TAB_STATE":
            networkImageCache.delete(tabId);
            popupState.delete(tabId);
            imageOrder.delete(tabId);
            sendResponse({ success: true });
            break;
        case "FETCH_IMAGE_BLOB":
            const { url } = message;
            const pUrl = tabUrls.get(tabId);
            if (pUrl) refererMap.set(url, pUrl);
            fetch(url).then(r => r.ok ? r.blob() : Promise.reject())
            .then(blob => {
                if (pUrl) setTimeout(() => refererMap.delete(url), 2000);
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                reader.onerror = () => sendResponse({ error: true });
                reader.readAsDataURL(blob);
            }).catch(() => {
                if (pUrl) refererMap.delete(url);
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
