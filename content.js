(function() {
    const injectScript = document.createElement('script');
    injectScript.textContent = `(function(){const c={};const o=CanvasRenderingContext2D.prototype.drawImage;let t=null;const b=[],h=new Set(),bc={};let bh=false;async function hb(l){const u=await l.arrayBuffer(),d=await crypto.subtle.digest('SHA-256',u);const arr=new Uint8Array(d);let str='';for(let i=0;i<arr.length;i++)str+=arr[i].toString(16).padStart(2,'0');return str;}const ou=URL.createObjectURL;URL.createObjectURL=function(l){const u=ou.apply(this,arguments);if(bh&&(l instanceof Blob)&&l.type.startsWith('image/')){bc[u]=l;hb(l).then(x=>{if(!h.has(x)){h.add(x);b.push(u)}})}return u};function gc(u){if(!u||typeof u!=='string'||u.startsWith('data:')||u.startsWith('blob:'))return u;try{const x=new URL(u,document.baseURI);if(/\\.(jpg|jpeg|png|webp|gif|svg|bmp|tiff)($|\\?)/i.test(x.pathname))return x.origin+x.pathname;return x.href}catch{return u}}function nt(){if(t)clearTimeout(t);t=setTimeout(()=>window.postMessage({type:"CANVAS_MAP_AUTO_UPDATE",data:c},"*"),300)}CanvasRenderingContext2D.prototype.drawImage=function(i,...a){const r=o.apply(this,[i,...a]);try{if(this._isInternal)return r;const s=i.src;if(!s||s.startsWith("data:"))return r;const u=gc(s);let e=c[u]||c[s];if(!e){e={width:0,height:0,instructions:[]};c[u]=e;c[s]=e;}if(!this.canvas.dataset.uidIntercepted)this.canvas.dataset.uidIntercepted='1';let p=null;if(a.length===2)p={sx:0,sy:0,sw:i.width,sh:i.height,dx:a[0],dy:a[1],dw:i.width,dh:i.height};else if(a.length===4)p={sx:0,sy:0,sw:i.width,sh:i.height,dx:a[0],dy:a[1],dw:a[2],dh:a[3]};else if(a.length===8)p={sx:a[0],sy:a[1],sw:a[2],sh:a[3],dx:a[4],dy:a[5],dw:a[6],dh:a[7]};if(p&&p.dw>0&&p.dh>0){e.width=Math.max(e.width,p.dx+p.dw);e.height=Math.max(e.height,p.dy+p.dh);e.instructions.push(p);nt()}}catch{}return r};window.addEventListener("message",e=>{if(!e.data)return;if(e.data==="REQUEST_CANVAS_MAP")nt();if(e.data==="ENABLE_BLOB_HOOK")bh=true;if(e.data==="REQUEST_BLOB_URLS")window.postMessage({type:"BLOB_URLS_RESPONSE",urls:b},"*");if(e.data.type==="PAGE_CONVERT_BLOB"){const u=e.data.url,cb=bc[u],cv=b=>{const r=new FileReader();r.onloadend=()=>window.postMessage({type:"PAGE_BLOB_CONVERTED",url:u,dataUrl:r.result},"*");r.readAsDataURL(b)};if(cb)cv(cb);else fetch(u).then(r=>r.blob()).then(b=>cv(b)).catch(()=>window.postMessage({type:"PAGE_BLOB_CONVERTED",url:u,error:true},"*"))}})})()`;
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
        window.postMessage("ENABLE_BLOB_HOOK", "*");
        if (res?.mode === 'default') startDomImageObserver();
    }).catch(() => {});

    setTimeout(() => window.postMessage("REQUEST_CANVAS_MAP", "*"), 500);

    let domObserverActive = false, domPushTimer = null;
    const domSeenUrls = new Set(), domPendingUrls = [];

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
        domSeenUrls.add(url); domPendingUrls.push(url); scheduleDomPush();
    }

    function observeImgElement(img) {
        if (img._isObserved) return; img._isObserved = true;
        const currentSrc = img.currentSrc || img.src;
        if (currentSrc) trackDomImage(normalizeDomUrl(currentSrc));
        img.addEventListener('load', function() { const loaded = img.currentSrc || img.src; if (loaded) trackDomImage(normalizeDomUrl(loaded)); }, { passive: true });
    }

    function startDomImageObserver() {
        if (domObserverActive) return; domObserverActive = true;
        document.querySelectorAll('img').forEach(observeImgElement);
        new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                const mut = mutations[i];
                if (mut.type === 'childList') {
                    mut.addedNodes.forEach(node => {
                        if (node.nodeType !== 1) return;
                        if (node.tagName === 'IMG') observeImgElement(node);
                        else { const imgs = node.getElementsByTagName('img'); for (let j = 0; j < imgs.length; j++) observeImgElement(imgs[j]); }
                    });
                } else if (mut.type === 'attributes' && mut.target.tagName === 'IMG') {
                    const src = mut.target.currentSrc || mut.target.src || mut.target.getAttribute('src');
                    if (src) trackDomImage(normalizeDomUrl(src));
                }
            }
        }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy'] });
    }

    browser.runtime.onMessage.addListener((msg) => { if (msg.type === "START_DOM_OBSERVER") startDomImageObserver(); });

    const CONFIG = { minSize: 50 };
    
    async function convertToBase64(url) {
        return new Promise((resolve) => {
            const img = new Image(); img.crossOrigin = "Anonymous";
            img.onload = () => {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                    canvas.getContext("2d").drawImage(img, 0, 0);
                    resolve(canvas.toDataURL("image/jpeg", 0.95));
                } catch { resolve(null); }
            };
            img.onerror = () => resolve(null); img.src = url;
        });
    }

    function isValidImage(url, width, height) {
        if (!url || (url.startsWith('data:') && url.length < 1366)) return false;
        if (url.startsWith('blob:')) return true;
        return !(width > 0 && height > 0 && width < CONFIG.minSize && height < CONFIG.minSize);
    }

    function scanPageOrdered() {
        const seen = new Set(), locationHref = window.location.href;
        const elements = document.querySelectorAll('img,div,span,a,section,header,main,article,li,figure');
        const imageData = [], smallImageData = [], bgRegex = /url\(['"]?([^'"]+)['"]?\)/g;

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            let candidates = [];
            if (el.tagName === 'IMG') {
                [el.getAttribute('data-original'), el.getAttribute('data-src'), el.dataset.src, el.currentSrc, el.src].forEach(src => { if (src) candidates.push({ url: src, w: el.naturalWidth, h: el.naturalHeight }); });
            } else if (el.offsetWidth > 0 || el.offsetHeight > 0) {
                const bg = window.getComputedStyle(el).getPropertyValue('background-image');
                if (bg && bg.startsWith('url(')) { let match; while ((match = bgRegex.exec(bg)) !== null) candidates.push({ url: match[1], w: 0, h: 0 }); bgRegex.lastIndex = 0; }
            }
            let best = null;
            for (let j = 0; j < candidates.length; j++) {
                let item = candidates[j], src = item.url;
                if (!src || src === locationHref) continue;
                if (!src.startsWith('http') && !src.startsWith('blob:') && !src.startsWith('data:')) { try { src = new URL(src, locationHref).href; } catch { continue; } }
                const score = src.startsWith('http') ? 3 : src.startsWith('blob:') ? 2 : 1;
                if (!best || score > best.score) best = { src, w: item.w, h: item.h, score };
            }
            if (best && !seen.has(best.src) && isValidImage(best.src, best.w, best.h)) {
                seen.add(best.src);
                const rect = el.getBoundingClientRect();
                const info = { url: best.src, w: best.w, h: best.h, position: { top: rect.top + window.scrollY, left: rect.left + window.scrollX } };
                (best.w > 0 && best.h > 0 && best.w < CONFIG.minSize && best.h < CONFIG.minSize ? smallImageData : imageData).push(info);
            }
        }
        const sortFn = (a, b) => { const topDiff = a.position.top - b.position.top; return Math.abs(topDiff) > 10 ? topDiff : a.position.left - b.position.left; };
        return [...imageData.sort(sortFn), ...smallImageData.sort(sortFn)].map(item => ({ url: item.url, w: item.w, h: item.h }));
    }

    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "SCAN_PAGE_ORDERED") sendResponse({ items: scanPageOrdered(), title: document.title });
        else if (msg.type === "SCAN_CANVAS") {
            const res = [];
            document.querySelectorAll('canvas').forEach(c => {
                if (c.width > 50) {
                    if (msg.mode === 'default' && c.dataset.uidIntercepted) return;
                    try { res.push(c.toDataURL()); } catch {}
                }
            });
            sendResponse({ urls: res });
        }
        else if (msg.type === "SCAN_BLOBS") {
            const listener = (e) => { if (e.data?.type === "BLOB_URLS_RESPONSE") { window.removeEventListener("message", listener); sendResponse({ urls: e.data.urls }); } };
            window.addEventListener("message", listener); window.postMessage("REQUEST_BLOB_URLS", "*"); return true;
        }
        else if (msg.type === "CONVERT_IMAGE") {
            if (msg.url.startsWith('blob:')) {
                const listener = (e) => { if (e.data?.type === "PAGE_BLOB_CONVERTED" && e.data.url === msg.url) { window.removeEventListener("message", listener); sendResponse({ dataUrl: e.data.dataUrl }); } };
                window.addEventListener("message", listener); window.postMessage({ type: "PAGE_CONVERT_BLOB", url: msg.url }, "*"); return true; 
            } else { convertToBase64(msg.url).then(dataUrl => sendResponse({ dataUrl })); return true; }
        }
        else if (msg.type === "GET_UNSCRAMBLE_DATA") { window.postMessage("REQUEST_CANVAS_MAP", "*"); sendResponse({ map: canvasMapCache }); }
    });
})();
