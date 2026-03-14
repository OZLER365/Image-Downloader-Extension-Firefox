globalThis.browser = chrome;

(function() {
    let canvasMapCache = {};
    window.addEventListener("message", (e) => {
        if (e.data && (e.data.type === "CANVAS_MAP_AUTO_UPDATE" || e.data.type === "CANVAS_MAP_RESPONSE")) {
            canvasMapCache = e.data.data;
            try { browser.runtime.sendMessage({ type: "CANVAS_MAP_PUSH", map: canvasMapCache }).catch(() => {}); } catch {}
        }
    });

    browser.runtime.sendMessage({ type: "GET_CURRENT_TAB_MODE" }).then(res => {
        window.postMessage("ENABLE_BLOB_HOOK", "*");
        if (res && res.mode === 'default') startDomImageObserver();
    }).catch(() => {});

    setTimeout(() => window.postMessage("REQUEST_CANVAS_MAP", "*"), 500);
    setTimeout(() => window.postMessage("REQUEST_CANVAS_MAP", "*"), 2000);

    let domObserverActive = false;
    const domSeenUrls = new Set();
    let domPushTimer = null;
    const domPendingUrls = [];

    function normalizeDomUrl(src) {
        if (!src || src.startsWith('data:') || src.length < 10) return null;
        try { return new URL(src, document.baseURI).href; } catch { return null; }
    }

    function scheduleDomPush() {
        if (domPushTimer) return;
        domPushTimer = setTimeout(() => {
            domPushTimer = null;
            if (domPendingUrls.length === 0) return;
            const batch = domPendingUrls.splice(0, domPendingUrls.length);
            try { browser.runtime.sendMessage({ type: "DOM_IMAGES_DISCOVERED", urls: batch }).catch(() => {}); } catch {}
        }, 400);
    }

    function trackDomImage(url) {
        if (!url || domSeenUrls.has(url)) return;
        domSeenUrls.add(url);
        domPendingUrls.push(url);
        scheduleDomPush();
    }

    function observeImgElement(img) {
        if (img._isObserved) return;
        img._isObserved = true;
        const currentSrc = img.currentSrc || img.src;
        if (currentSrc) trackDomImage(normalizeDomUrl(currentSrc));
        img.addEventListener('load', function() {
            const loaded = img.currentSrc || img.src;
            if (loaded) trackDomImage(normalizeDomUrl(loaded));
        }, { passive: true });
    }

    function startDomImageObserver() {
        if (domObserverActive) return;
        domObserverActive = true;
        document.querySelectorAll('img').forEach(observeImgElement);
        const mo = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                if (mut.type === 'childList') {
                    for (const node of mut.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === 'IMG') observeImgElement(node);
                        else {
                            const imgs = node.getElementsByTagName('img');
                            for (let j = 0; j < imgs.length; j++) observeImgElement(imgs[j]);
                        }
                    }
                } else if (mut.type === 'attributes' && mut.target.tagName === 'IMG') {
                    const src = mut.target.currentSrc || mut.target.src || mut.target.getAttribute('src');
                    if (src) trackDomImage(normalizeDomUrl(src));
                }
            }
        });
        mo.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy']
        });
    }

    const CONFIG = { minSize: 50 };

    async function convertToBase64(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    canvas.getContext("2d").drawImage(img, 0, 0);
                    resolve(canvas.toDataURL("image/jpeg", 0.95));
                } catch { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    function isValidImage(url, width, height) {
        if (!url) return false;
        if (url.startsWith('data:') && url.length < 1366) return false;
        if (url.startsWith('blob:')) return true;
        return !(width > 0 && height > 0 && width < CONFIG.minSize && height < CONFIG.minSize);
    }

    function scanPageOrdered() {
        const seen = new Set(), locationHref = window.location.href;
        const elements = document.querySelectorAll('img,div,span,a,section,header,main,article,li,figure');
        const imageData = [], smallImageData = [];
        const bgRegex = /url\(['"]?([^'"]+)['"]?\)/g;

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            let candidates = [];
            if (el.tagName === 'IMG') {
                [el.getAttribute('data-original'), el.getAttribute('data-src'), el.dataset.src, el.currentSrc, el.src].forEach(src => {
                    if (src) candidates.push({ url: src, w: el.naturalWidth, h: el.naturalHeight });
                });
            } else if (el.offsetWidth > 0 || el.offsetHeight > 0) {
                const bg = window.getComputedStyle(el).getPropertyValue('background-image');
                if (bg && bg.startsWith('url(')) {
                    let match;
                    bgRegex.lastIndex = 0;
                    while ((match = bgRegex.exec(bg)) !== null) candidates.push({ url: match[1], w: 0, h: 0 });
                }
            }
            let best = null;
            for (let j = 0; j < candidates.length; j++) {
                let src = candidates[j].url;
                if (!src || src === locationHref) continue;
                if (!src.startsWith('http') && !src.startsWith('blob:') && !src.startsWith('data:')) {
                    try { src = new URL(src, locationHref).href; } catch { continue; }
                }
                const score = src.startsWith('http') ? 3 : src.startsWith('blob:') ? 2 : 1;
                if (!best || score > best.score) best = { src, w: candidates[j].w, h: candidates[j].h, score };
            }
            if (best && !seen.has(best.src) && isValidImage(best.src, best.w, best.h)) {
                seen.add(best.src);
                const rect = el.getBoundingClientRect();
                const info = { url: best.src, w: best.w, h: best.h, position: { top: rect.top + window.scrollY, left: rect.left + window.scrollX } };
                (best.w > 0 && best.h > 0 && best.w < CONFIG.minSize && best.h < CONFIG.minSize ? smallImageData : imageData).push(info);
            }
        }

        const sortFn = (a, b) => {
            const topDiff = a.position.top - b.position.top;
            return Math.abs(topDiff) > 10 ? topDiff : a.position.left - b.position.left;
        };
        return [...imageData.sort(sortFn), ...smallImageData.sort(sortFn)].map(item => ({ url: item.url, w: item.w, h: item.h }));
    }

    // Merged into a single listener for efficiency
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "START_DOM_OBSERVER") {
            startDomImageObserver();
            return;
        }
        if (msg.type === "SCAN_PAGE_ORDERED") {
            sendResponse({ items: scanPageOrdered(), title: document.title });
        } else if (msg.type === "SCAN_CANVAS") {
            const res = [];
            document.querySelectorAll('canvas').forEach(c => {
                if (c.width > 50) {
                    // Default mode only: skip canvases whose source images are already captured
                    // via the drawImage intercept pipeline. canvas.toDataURL() re-encodes the
                    // image producing a different SHA-256 hash that bypasses the dedup check.
                    if (msg.mode === 'default' && c.dataset.uidIntercepted) return;
                    try { res.push(c.toDataURL()); } catch {}
                }
            });
            sendResponse({ urls: res });
        } else if (msg.type === "SCAN_BLOBS") {
            const listener = (e) => {
                if (e.data && e.data.type === "BLOB_URLS_RESPONSE") {
                    window.removeEventListener("message", listener);
                    sendResponse({ urls: e.data.urls });
                }
            };
            window.addEventListener("message", listener);
            window.postMessage("REQUEST_BLOB_URLS", "*");
            return true;
        } else if (msg.type === "CONVERT_IMAGE") {
            if (msg.url.startsWith('blob:')) {
                const listener = (e) => {
                    if (e.data && e.data.type === "PAGE_BLOB_CONVERTED" && e.data.url === msg.url) {
                        window.removeEventListener("message", listener);
                        sendResponse({ dataUrl: e.data.dataUrl });
                    }
                };
                window.addEventListener("message", listener);
                window.postMessage({ type: "PAGE_CONVERT_BLOB", url: msg.url }, "*");
                return true;
            } else {
                convertToBase64(msg.url).then(dataUrl => sendResponse({ dataUrl }));
                return true;
            }
        } else if (msg.type === "FETCH_AND_CONVERT") {
            fetch(msg.url).then(r => r.blob()).then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                reader.onerror = () => sendResponse({ dataUrl: null });
                reader.readAsDataURL(blob);
            }).catch(() => sendResponse({ dataUrl: null }));
            return true;
        } else if (msg.type === "EXECUTE_ANDROID_DOWNLOAD") {
            const execute = async () => {
                let urlToDownload = msg.dataUrl;
                let revoke = false;
                if (!urlToDownload.startsWith('data:')) {
                    try {
                        const blob = await fetch(urlToDownload).then(r => r.blob());
                        urlToDownload = URL.createObjectURL(blob);
                        revoke = true;
                    } catch { return; }
                }
                const a = document.createElement('a');
                a.href = urlToDownload;
                a.download = msg.filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                await new Promise(r => setTimeout(r, 500));
                document.body.removeChild(a);
                if (revoke) URL.revokeObjectURL(urlToDownload);
            };
            execute();
            sendResponse({ success: true });
            return true;
        } else if (msg.type === "GET_UNSCRAMBLE_DATA") {
            window.postMessage("REQUEST_CANVAS_MAP", "*");
            sendResponse({ map: canvasMapCache });
        }
    });
})();
