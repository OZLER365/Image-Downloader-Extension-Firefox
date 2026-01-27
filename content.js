(function() {
    const CONFIG = { minSize: 50 };

    async function convertToBase64(url) {
        return new Promise((resolve) => {
            if (url.startsWith('blob:')) {
                fetch(url).then(r => r.blob()).then(b => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(b);
                }).catch(() => resolve(null));
                return;
            }
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
        if (!url || url.length > 2000000) return false;
        if (url.startsWith('blob:')) return true;
        return !(width > 0 && height > 0 && width < CONFIG.minSize && height < CONFIG.minSize);
    }

    function isSmallImage(width, height) {
        return width > 0 && height > 0 && width < CONFIG.minSize && height < CONFIG.minSize;
    }

    function getElementPosition(el) {
        const rect = el.getBoundingClientRect();
        return {
            top: rect.top + (window.pageYOffset || document.documentElement.scrollTop),
            left: rect.left + (window.pageXOffset || document.documentElement.scrollLeft),
            element: el
        };
    }

    function scanPageOrdered() {
        const seen = new Set();
        const locationHref = window.location.href;
        const elements = document.querySelectorAll('img, div, span, a, section, header, main, article, li, figure');
        
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
                    const pos = getElementPosition(el);
                    const info = { url: bestCandidate.src, position: pos, domOrder: imageData.length + smallImageData.length };
                    (isSmallImage(bestCandidate.w, bestCandidate.h) ? smallImageData : imageData).push(info);
                }
            }
        });

        const sortFn = (a, b) => {
            const topDiff = a.position.top - b.position.top;
            if (Math.abs(topDiff) > 10) return topDiff;
            return a.position.left - b.position.left;
        };

        return [...imageData.sort(sortFn), ...smallImageData.sort(sortFn)].map(item => item.url);
    }

    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "SCAN_PAGE_ORDERED") sendResponse({ urls: scanPageOrdered(), title: document.title });
        else if (msg.type === "SCAN_CANVAS") {
            const res = [];
            document.querySelectorAll('canvas').forEach(c => { if(c.width > 50) try{res.push(c.toDataURL())}catch{} });
            sendResponse({ urls: res });
        }
        else if (msg.type === "CONVERT_IMAGE") {
            convertToBase64(msg.url).then(dataUrl => sendResponse({ dataUrl }));
            return true;
        }
    });
})();
