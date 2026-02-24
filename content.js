(function() {
    const injectScript = document.createElement('script');
    injectScript.textContent = `(function(){const c={};const o=CanvasRenderingContext2D.prototype.drawImage;let t=null;const b=[],h=new Set(),bc={};let bh=false;async function hb(l){const u=await l.arrayBuffer(),d=await crypto.subtle.digest('SHA-256',u);return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,'0')).join('')}const ou=URL.createObjectURL;URL.createObjectURL=function(l){const u=ou.apply(this,arguments);if(bh&&(l instanceof Blob)&&l.type.startsWith('image/')){if(l.size<1024)return u;bc[u]=l;hb(l).then(x=>{if(!h.has(x)){h.add(x);b.push(u)}})}return u};function gc(u){if(!u||typeof u!=='string'||u.startsWith('data:')||u.startsWith('blob:'))return u;try{const x=new URL(u,document.baseURI);if(/\\.(jpg|jpeg|png|webp|gif|svg|bmp|tiff)($|\\?)/i.test(x.pathname))return x.origin+x.pathname;return x.href}catch{return u}}function nt(){if(t)clearTimeout(t);t=setTimeout(()=>window.postMessage({type:"CANVAS_MAP_AUTO_UPDATE",data:c},"*"),300)}CanvasRenderingContext2D.prototype.drawImage=function(i,...a){const r=o.apply(this,[i,...a]);try{if(this._isInternal)return r;const s=i.src;if(!s||s.startsWith("data:"))return r;const u=gc(s);let e=c[u]||c[s];if(!e){e={width:0,height:0,instructions:[]};c[u]=e;c[s]=e;c[s.split('?')[0]]=e}let p=null;if(a.length===2)p={sx:0,sy:0,sw:i.width,sh:i.height,dx:a[0],dy:a[1],dw:i.width,dh:i.height};else if(a.length===4)p={sx:0,sy:0,sw:i.width,sh:i.height,dx:a[0],dy:a[1],dw:a[2],dh:a[3]};else if(a.length===8)p={sx:a[0],sy:a[1],sw:a[2],sh:a[3],dx:a[4],dy:a[5],dw:a[6],dh:a[7]};if(p&&p.dw>0&&p.dh>0){e.width=Math.max(e.width,p.dx+p.dw);e.height=Math.max(e.height,p.dy+p.dh);e.instructions.push(p);nt()}}catch{}return r};window.addEventListener("message",e=>{if(!e.data)return;if(e.data==="REQUEST_CANVAS_MAP")nt();if(e.data==="ENABLE_BLOB_HOOK")bh=true;if(e.data==="REQUEST_BLOB_URLS")window.postMessage({type:"BLOB_URLS_RESPONSE",urls:b},"*");if(e.data.type==="PAGE_CONVERT_BLOB"){const u=e.data.url,cb=bc[u],cv=b=>{const r=new FileReader();r.onloadend=()=>window.postMessage({type:"PAGE_BLOB_CONVERTED",url:u,dataUrl:r.result},"*");r.readAsDataURL(b)};if(cb)cv(cb);else fetch(u).then(r=>r.blob()).then(b=>cv(b)).catch(()=>window.postMessage({type:"PAGE_BLOB_CONVERTED",url:u,error:true},"*"))}})})()`;
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
        const bgRegex = /url\(['"]?([^'"]+)['"]?\)/g;

        elements.forEach(el => {
            let candidates = [];
            if (el.tagName === 'IMG') {
                [el.getAttribute('data-original'), el.getAttribute('data-src'), el.dataset.src, el.currentSrc, el.src].forEach(src => {
                    if (src) candidates.push({ url: src, w: el.naturalWidth, h: el.naturalHeight });
                });
            } else if (el.offsetWidth > 0 || el.offsetHeight > 0) {
                // Optimization: Check inline style first to avoid getComputedStyle if possible, though strict CSS classes require it.
                // We proceed carefully.
                const style = window.getComputedStyle(el);
                const bg = style.backgroundImage;
                if (bg && bg.startsWith('url(')) {
                    let match;
                    while ((match = bgRegex.exec(bg)) !== null) {
                        candidates.push({ url: match[1], w: 0, h: 0 });
                    }
                    // Reset regex lastIndex is important if reused, but here we create new iterator via matchAll or simple exec loop
                    bgRegex.lastIndex = 0; 
                }
            }
            let best = null;
            for (const item of candidates) {
                let src = item.url;
                if (!src || src === locationHref) continue;
                if (!src.startsWith('http') && !src.startsWith('blob:') && !src.startsWith('data:')) {
                    try { src = new URL(src, locationHref).href; } catch { continue; }
                }
                const score = src.startsWith('http') ? 3 : src.startsWith('blob:') ? 2 : 1;
                if (!best || score > best.score) best = { src, w: item.w, h: item.h, score };
            }
            if (best && !seen.has(best.src)) {
                if (isValidImage(best.src, best.w, best.h)) {
                    seen.add(best.src);
                    const rect = el.getBoundingClientRect();
                    const info = { url: best.src, w: best.w, h: best.h, position: { top: rect.top + window.scrollY, left: rect.left + window.scrollX } };
                    (best.w > 0 && best.h > 0 && best.w < CONFIG.minSize && best.h < CONFIG.minSize ? smallImageData : imageData).push(info);
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
