const networkImageCache = new Map();
const tabUrls = new Map();
const popupState = new Map(); 
const refererMap = new Map();
const imageOrder = new Map();
const tabNetworkMode = new Map();

const CDN_WHITELIST = new Set(['pstatic.net','webtoons.com','cloudinary.com','imgur.com','amazonaws.com','cloudfront.net','akamaized.net','fastly.net','cdn','images','img','static','media','assets','photos','googleusercontent.com','gstatic.com','twimg.com','fbcdn.net','pinimg.com','shopify.com','wordpress.com','wixstatic.com','unsplash.com','pexels.com','giphy.com','tenor.com']);

browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") browser.tabs.create({ url: "https://buymeacoffee.com/ozler" });
});

browser.tabs.onRemoved.addListener((tabId) => {
    networkImageCache.delete(tabId);
    tabUrls.delete(tabId);
    popupState.delete(tabId);
    imageOrder.delete(tabId);
    tabNetworkMode.delete(tabId);
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
        if (networkMode) {
            const urlLower = imageUrl.toLowerCase();
            if ([...CDN_WHITELIST].some(cdn => urlLower.includes(cdn))) return true;
            if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|jfif)(\?|$)/i.test(imageUrl)) return true;
        } else {
            const imgOrigin = new URL(imageUrl).origin;
            const pageOrigin = new URL(pageUrl).origin;
            if (imgOrigin === pageOrigin) return true;
            const commonCdns = ['pstatic.net','webtoons.com','cloudinary.com','imgur.com','gstatic.com','googleusercontent.com'];
            if (commonCdns.some(cdn => imageUrl.toLowerCase().includes(cdn))) return true;
        }
    } catch {}
    return networkMode;
}

function addImageToCache(tabId, url, mode = 'default') {
    if (!networkImageCache.has(tabId)) networkImageCache.set(tabId, { default: new Set(), network: new Set(), blob: new Set() });
    const caches = networkImageCache.get(tabId);
    const targetSet = caches[mode] || caches.default;
    if (!targetSet.has(url) && targetSet.size < 2000) {
        targetSet.add(url);
        if (!imageOrder.has(tabId)) imageOrder.set(tabId, new Map());
        const orderMap = imageOrder.get(tabId);
        if (!orderMap.has(url)) orderMap.set(url, orderMap.size);
    }
}

browser.webRequest.onCompleted.addListener(
    (details) => {
        if (details.statusCode !== 200) return;
        if (details.responseHeaders) {
            const lenHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
            if (lenHeader) {
                const size = parseInt(lenHeader.value);
                if (!isNaN(size) && size < 1024) return;
            }
        }
        const tabsToCheck = details.tabId !== -1 ? [details.tabId] : [...tabUrls.keys()];
        tabsToCheck.forEach(tId => {
            const networkMode = tabNetworkMode.get(tId) || 'default';
            const isNetworkMode = (networkMode === 'network' || networkMode === true);
            if (!isNetworkMode && details.type !== 'image') return;
            let imageUrl = details.url;
            if (details.type !== 'image') {
                const typeHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type');
                if (!typeHeader) return;
                const contentType = typeHeader.value.toLowerCase();
                if (!contentType.startsWith('image/') && !contentType.includes('application/octet-stream')) return;
            }
            const pageUrl = tabUrls.get(tId);
            if (pageUrl && isImageFromCurrentPage(imageUrl, pageUrl, isNetworkMode)) {
                const targetMode = isNetworkMode ? 'network' : (networkMode === 'blob' ? 'blob' : 'default');
                addImageToCache(tId, imageUrl, targetMode);
            }
        });
    },
    { urls: ["<all_urls>"], types: ["image","xmlhttprequest","other","main_frame","sub_frame","object","media"] },
    ["responseHeaders"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (refererMap.has(details.url)) {
            const referer = refererMap.get(details.url);
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
            const currentMode = tabNetworkMode.get(tabId) || 'default';
            const reqMode = (currentMode === 'network' || currentMode === true) ? 'network' : (currentMode === 'blob' ? 'blob' : 'default');
            let images = [];
            if (networkImageCache.has(tabId)) {
                const caches = networkImageCache.get(tabId);
                if (caches[reqMode]) images = Array.from(caches[reqMode]);
            }
            if (imageOrder.has(tabId)) {
                const orderMap = imageOrder.get(tabId);
                images.sort((a, b) => (orderMap.get(a) ?? Infinity) - (orderMap.get(b) ?? Infinity));
            }
            sendResponse({ images });
            break;
        case "SET_NETWORK_MODE":
            tabNetworkMode.set(tabId, message.networkMode);
            sendResponse({ success: true });
            break;
        case "GET_CURRENT_TAB_MODE":
            sendResponse({ mode: sender.tab ? (tabNetworkMode.get(sender.tab.id) || 'default') : 'default' });
            break;
        case "SAVE_STATE":
            popupState.set(tabId, message.state);
            if (message.state?.networkMode !== undefined) tabNetworkMode.set(tabId, message.state.networkMode);
            if (message.state?.tabUrl) tabUrls.set(tabId, message.state.tabUrl);
            sendResponse({ success: true });
            break;
        case "GET_STATE":
            let state = popupState.get(tabId);
            if (!state && tabNetworkMode.has(tabId)) state = { networkMode: tabNetworkMode.get(tabId) };
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
            const pageUrl = tabUrls.get(tabId);
            if (pageUrl) refererMap.set(url, pageUrl);
            fetch(url).then(r => {
                if (!r.ok) throw new Error();
                return r.blob();
            }).then(blob => {
                if (pageUrl) setTimeout(() => refererMap.delete(url), 2000);
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                reader.onerror = () => sendResponse({ error: true });
                reader.readAsDataURL(blob);
            }).catch(() => {
                if (pageUrl) refererMap.delete(url);
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
