(function() {
    const injectScript = document.createElement('script');
    injectScript.textContent = `
    (function() {
        const canvasMap = {}; 
        const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
        let updateTimer = null;
        const blobUrls = [];
        const blobHashes = new Set();
        const blobCache = {}; 
        let blobHookEnabled = false;

        async function hashBlob(blob) {
            const buffer = await blob.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        const originalCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function(blob) {
            const url = originalCreateObjectURL.apply(this, arguments);
            if (blobHookEnabled && (blob instanceof Blob) && blob.type.startsWith('image/')) {
                if (blob.size < 1024) return url;
                blobCache[url] = blob;
                hashBlob(blob).then(hash => {
                    if (!blobHashes.has(hash)) {
                        blobHashes.add(hash);
                        blobUrls.push(url);
                    }
                });
            }
            return url;
        };

        function getCanonicalUrl(url) {
            if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) return url;
            try {
                const u = new URL(url, document.baseURI);
                if (/\\.(jpg|jpeg|png|webp|gif|svg|bmp|tiff)($|\\?)/i.test(u.pathname)) return u.origin + u.pathname; 
                return u.href;
            } catch { return url; }
        }

        function notifyExtension() {
            if (updateTimer) clearTimeout(updateTimer);
            updateTimer = setTimeout(() => window.postMessage({ type: "CANVAS_MAP_AUTO_UPDATE", data: canvasMap }, "*"), 300);
        }

        CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
            const result = originalDrawImage.apply(this, [image, ...args]);
            try {
                if (this._isInternal) return result;
                const src = image.src;
                if (!src || src.startsWith("data:")) return result;
                const cUrl = getCanonicalUrl(src);
                let entry = canvasMap[cUrl] || canvasMap[src];
                if (!entry) {
                    entry = { width: 0, height: 0, instructions: [] };
                    canvasMap[cUrl] = entry;
                    canvasMap[src] = entry;
                    canvasMap[src.split('?')[0]] = entry;
                }
                let p = null;
                if (args.length === 2) p = { sx: 0, sy: 0, sw: image.width, sh: image.height, dx: args[0], dy: args[1], dw: image.width, dh: image.height };
                else if (args.length === 4) p = { sx: 0, sy: 0, sw: image.width, sh: image.height, dx: args[0], dy: args[1], dw: args[2], dh: args[3] };
                else if (args.length === 8) p = { sx: args[0], sy: args[1], sw: args[2], sh: args[3], dx: args[4], dy: args[5], dw: args[6], dh: args[7] };
                if (p && p.dw > 0 && p.dh > 0) {
                    entry.width = Math.max(entry.width, p.dx + p.dw);
                    entry.height = Math.max(entry.height, p.dy + p.dh);
                    entry.instructions.push(p);
                    notifyExtension();
                }
            } catch {}
            return result;
        };

        window.addEventListener("message", (e) => {
            if (!e.data) return;
            if (e.data === "REQUEST_CANVAS_MAP") notifyExtension();
            if (e.data === "ENABLE_BLOB_HOOK") blobHookEnabled = true;
            if (e.data === "REQUEST_BLOB_URLS") window.postMessage({ type: "BLOB_URLS_RESPONSE", urls: blobUrls }, "*");
            if (e.data.type === "PAGE_CONVERT_BLOB") {
                const url = e.data.url;
                const cachedBlob = blobCache[url];
                const convertBlob = (b) => {
                    const reader = new FileReader();
                    reader.onloadend = () => window.postMessage({ type: "PAGE_BLOB_CONVERTED", url: url, dataUrl: reader.result }, "*");
                    reader.readAsDataURL(b);
                };
                if (cachedBlob) {
                    convertBlob(cachedBlob);
                } else {
                    fetch(url).then(r => r.blob()).then(b => convertBlob(b)).catch(() => window.postMessage({ type: "PAGE_BLOB_CONVERTED", url: url, error: true }, "*"));
                }
            }
        });
    })();`;
    (document.head || document.documentElement).appendChild(injectScript);
    injectScript.remove();

    let canvasMapCache = {};
    window.addEventListener("message", (e) => {
        if (e.data && (e.data.type === "CANVAS_MAP_AUTO_UPDATE" || e.data.type === "CANVAS_MAP_RESPONSE")) {
            canvasMapCache = e.data.data;
            try { browser.runtime.sendMessage({ type: "CANVAS_MAP_PUSH", map: canvasMapCache }).catch(() => {}); } catch {}
        }
    });

    browser.runtime.sendMessage({ type: "GET_CURRENT_TAB_MODE" }).then(res => {
        if (res && res.mode === 'blob') window.postMessage("ENABLE_BLOB_HOOK", "*");
    }).catch(() => {});

    setTimeout(() => window.postMessage("REQUEST_CANVAS_MAP", "*"), 500);
    setTimeout(() => window.postMessage("REQUEST_CANVAS_MAP", "*"), 2000);

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

        elements.forEach(el => {
            let candidates = [];
            if (el.tagName === 'IMG') {
                [el.getAttribute('data-original'), el.getAttribute('data-src'), el.dataset.src, el.currentSrc, el.src].forEach(src => {
                    if (src) candidates.push({ url: src, w: el.naturalWidth, h: el.naturalHeight });
                });
            } else if (el.offsetWidth > 0 || el.offsetHeight > 0) {
                const bg = window.getComputedStyle(el).backgroundImage;
                if (bg && bg.startsWith('url(')) {
                    const matches = bg.match(/url\(['"]?([^'"]+)['"]?\)/g);
                    if (matches) matches.forEach(match => candidates.push({ url: match.replace(/url\(['"]?|['"]?\)/g, ''), w: 0, h: 0 }));
                }
            }
            let bestCandidate = null;
            for (let item of candidates) {
                let src = item.url;
                if (!src || src === locationHref) continue;
                if (!src.startsWith('http') && !src.startsWith('blob:') && !src.startsWith('data:')) {
                    try { src = new URL(src, locationHref).href; } catch { continue; }
                }
                let score = src.startsWith('http') ? 3 : src.startsWith('blob:') ? 2 : 1;
                if (!bestCandidate || score > bestCandidate.score) bestCandidate = { src, w: item.w, h: item.h, score };
            }
            if (bestCandidate && !seen.has(bestCandidate.src)) {
                if (isValidImage(bestCandidate.src, bestCandidate.w, bestCandidate.h)) {
                    seen.add(bestCandidate.src);
                    const rect = el.getBoundingClientRect();
                    const pos = { top: rect.top + window.scrollY, left: rect.left + window.scrollX };
                    const info = { url: bestCandidate.src, w: bestCandidate.w, h: bestCandidate.h, position: pos };
                    (bestCandidate.w > 0 && bestCandidate.h > 0 && bestCandidate.w < CONFIG.minSize && bestCandidate.h < CONFIG.minSize ? smallImageData : imageData).push(info);
                }
            }
        });

        const sortFn = (a, b) => {
            const topDiff = a.position.top - b.position.top;
            return Math.abs(topDiff) > 10 ? topDiff : a.position.left - b.position.left;
        };
        return [...imageData.sort(sortFn), ...smallImageData.sort(sortFn)].map(item => ({ url: item.url, w: item.w, h: item.h }));
    }

    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "SCAN_PAGE_ORDERED") sendResponse({ items: scanPageOrdered(), title: document.title });
        else if (msg.type === "SCAN_CANVAS") {
            const res = [];
            document.querySelectorAll('canvas').forEach(c => { if(c.width > 50) try{res.push(c.toDataURL())}catch{} });
            sendResponse({ urls: res });
        }
        else if (msg.type === "SCAN_BLOBS") {
            const listener = (e) => {
                if (e.data && e.data.type === "BLOB_URLS_RESPONSE") {
                    window.removeEventListener("message", listener);
                    sendResponse({ urls: e.data.urls });
                }
            };
            window.addEventListener("message", listener);
            window.postMessage("REQUEST_BLOB_URLS", "*");
            return true;
        }
        else if (msg.type === "CONVERT_IMAGE") {
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
        }
        else if (msg.type === "GET_UNSCRAMBLE_DATA") {
            window.postMessage("REQUEST_CANVAS_MAP", "*");
            sendResponse({ map: canvasMapCache });
        }
    });
})();
