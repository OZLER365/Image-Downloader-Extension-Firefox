const networkImageCache = new Map();
const tabUrls = new Map();
const popupState = new Map(); 
const refererMap = new Map();
const imageOrder = new Map();
const tabNetworkMode = new Map();

// Optimization: Use Set for O(1) lookup
const CDN_WHITELIST = new Set([
    'pstatic.net', 'webtoons.com', 'cloudinary.com', 'imgur.com',
    'amazonaws.com', 'cloudfront.net', 'akamaized.net', 'fastly.net',
    'cdn', 'images', 'img', 'static', 'media', 'assets', 'photos',
    'googleusercontent.com', 'gstatic.com', 'twimg.com', 'fbcdn.net',
    'pinimg.com', 'shopify.com', 'wordpress.com', 'wixstatic.com',
    'unsplash.com', 'pexels.com', 'giphy.com', 'tenor.com'
]);

browser.tabs.onRemoved.addListener((tabId) => {
    networkImageCache.delete(tabId);
    tabUrls.delete(tabId);
    popupState.delete(tabId);
    imageOrder.delete(tabId);
    tabNetworkMode.delete(tabId);
});

// Detect URL changes or Refresh to clear cache
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const isUrlChange = changeInfo.url && changeInfo.url !== tabUrls.get(tabId);
    const isRefresh = changeInfo.status === 'loading';

    if (isUrlChange || isRefresh) {
        if (changeInfo.url) tabUrls.set(tabId, changeInfo.url);
        networkImageCache.delete(tabId);
        popupState.delete(tabId);
        imageOrder.delete(tabId);
    }
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
            const commonCdns = ['pstatic.net', 'webtoons.com', 'cloudinary.com', 'imgur.com', 'gstatic.com', 'googleusercontent.com'];
            if (commonCdns.some(cdn => imageUrl.toLowerCase().includes(cdn))) return true;
        }
    } catch (e) {}
    return networkMode;
}

function isImageContentType(headerValue) {
    if (!headerValue) return false;
    const v = headerValue.toLowerCase();
    return v.startsWith('image/') || v.includes('application/octet-stream');
}

function addImageToCache(tabId, url) {
    if (!networkImageCache.has(tabId)) networkImageCache.set(tabId, new Set());
    const cache = networkImageCache.get(tabId);
    if (!cache.has(url) && cache.size < 2000) {
        cache.add(url);
        if (!imageOrder.has(tabId)) imageOrder.set(tabId, new Map());
        const orderMap = imageOrder.get(tabId);
        if (!orderMap.has(url)) orderMap.set(url, orderMap.size);
    }
}

browser.webRequest.onCompleted.addListener(
    (details) => {
        if (details.statusCode !== 200 || details.tabId === -1) return;

        // Optimization: Filter by Content-Length immediately (Skip < 1KB)
        if (details.responseHeaders) {
            const lenHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
            if (lenHeader) {
                const size = parseInt(lenHeader.value);
                if (!isNaN(size) && size < 1024) return;
            }
        }

        const networkMode = tabNetworkMode.get(details.tabId) || false;
        if (!networkMode && details.type !== 'image') return;

        let imageUrl = details.url;
        if (details.type !== 'image') {
            const typeHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type');
            if (!typeHeader || !isImageContentType(typeHeader.value)) return;
        }

        browser.tabs.get(details.tabId).then(tab => {
            if (tab && tab.url && isImageFromCurrentPage(imageUrl, tab.url, networkMode)) {
                addImageToCache(details.tabId, imageUrl);
            }
        }).catch(() => {});
    },
    { 
        urls: ["<all_urls>"], 
        types: ["image", "xmlhttprequest", "other", "main_frame", "sub_frame", "object", "media"] 
    },
    ["responseHeaders"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (refererMap.has(details.url)) {
            const referer = refererMap.get(details.url);
            let hasReferer = false;
            for (let i = 0; i < details.requestHeaders.length; i++) {
                if (details.requestHeaders[i].name.toLowerCase() === "referer") {
                    details.requestHeaders[i].value = referer;
                    hasReferer = true;
                    break;
                }
            }
            if (!hasReferer) {
                details.requestHeaders.push({ name: "Referer", value: referer });
            }
            return { requestHeaders: details.requestHeaders };
        }
    },
    { urls: ["<all_urls>"] },
    ["blocking", "requestHeaders"]
);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case "GET_NETWORK_IMAGES":
            const images = networkImageCache.has(message.tabId) ? Array.from(networkImageCache.get(message.tabId)) : [];
            if (imageOrder.has(message.tabId)) {
                const orderMap = imageOrder.get(message.tabId);
                images.sort((a, b) => (orderMap.get(a) ?? Infinity) - (orderMap.get(b) ?? Infinity));
            }
            sendResponse({ images });
            return false;

        case "SET_NETWORK_MODE":
            tabNetworkMode.set(message.tabId, message.networkMode);
            sendResponse({ success: true });
            return false;

        case "SAVE_STATE":
            popupState.set(message.tabId, message.state);
            if (message.state?.networkMode !== undefined) {
                tabNetworkMode.set(message.tabId, message.state.networkMode);
            }
            if (message.state?.tabUrl) {
                tabUrls.set(message.tabId, message.state.tabUrl);
            }
            sendResponse({ success: true });
            return false;

        case "GET_STATE":
            let state = popupState.get(message.tabId);
            if (!state && tabNetworkMode.has(message.tabId)) {
                state = { networkMode: tabNetworkMode.get(message.tabId) };
            }
            sendResponse({ state });
            return false;

        case "CLEAR_TAB_STATE":
            networkImageCache.delete(message.tabId);
            popupState.delete(message.tabId);
            imageOrder.delete(message.tabId);
            sendResponse({ success: true });
            return false;

        case "FETCH_IMAGE_BLOB":
            const { url, tabId } = message;
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
        const headers = details.responseHeaders.filter(h => 
            !['access-control-allow-origin', 'content-security-policy'].includes(h.name.toLowerCase())
        );
        headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
        return { responseHeaders: headers };
    },
    { urls: ["<all_urls>"], types: ["image", "media"] }, 
    ["blocking", "responseHeaders"]
);
