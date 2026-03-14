(function() {
    const c = {};
    const o = CanvasRenderingContext2D.prototype.drawImage;
    let t = null;
    const b = [], h = new Set(), bc = {};
    let bh = false;

    async function hb(l) {
        const u = await l.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', u);
        const arr = new Uint8Array(d);
        let str = '';
        for (let i = 0; i < arr.length; i++) {
            str += arr[i].toString(16).padStart(2, '0');
        }
        return str;
    }

    const ou = URL.createObjectURL;
    URL.createObjectURL = function(l) {
        const u = ou.apply(this, arguments);
        if (bh && (l instanceof Blob) && l.type.startsWith('image/')) {
            bc[u] = l;
            hb(l).then(x => {
                if (!h.has(x)) {
                    h.add(x);
                    b.push(u);
                }
            });
        }
        return u;
    };

    function gc(u) {
        if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('blob:')) return u;
        try {
            const x = new URL(u, document.baseURI);
            if (/\.(jpg|jpeg|png|webp|gif|svg|bmp|tiff)($|\?)/i.test(x.pathname)) return x.origin + x.pathname;
            return x.href;
        } catch {
            return u;
        }
    }

    function nt() {
        if (t) clearTimeout(t);
        t = setTimeout(() => window.postMessage({ type: "CANVAS_MAP_AUTO_UPDATE", data: c }, "*"), 300);
    }

    CanvasRenderingContext2D.prototype.drawImage = function(i, ...a) {
        const r = o.apply(this, [i, ...a]);
        try {
            if (this._isInternal) return r;
            const s = i.src;
            if (!s || s.startsWith("data:")) return r;
            const u = gc(s);
            let e = c[u] || c[s];
            if (!e) {
                e = { width: 0, height: 0, instructions: [] };
                c[u] = e;
                c[s] = e;
            }
            // Mark this canvas so the toDataURL() scan in content.js skips it in default mode.
            // Its source image is already captured via the drawImage intercept pipeline;
            // canvas.toDataURL() re-encodes as JPEG producing a different hash that bypasses dedup.
            if (!this.canvas.dataset.uidIntercepted) this.canvas.dataset.uidIntercepted = '1';
            let p = null;
            if (a.length === 2) p = { sx: 0, sy: 0, sw: i.width, sh: i.height, dx: a[0], dy: a[1], dw: i.width, dh: i.height };
            else if (a.length === 4) p = { sx: 0, sy: 0, sw: i.width, sh: i.height, dx: a[0], dy: a[1], dw: a[2], dh: a[3] };
            else if (a.length === 8) p = { sx: a[0], sy: a[1], sw: a[2], sh: a[3], dx: a[4], dy: a[5], dw: a[6], dh: a[7] };
            if (p && p.dw > 0 && p.dh > 0) {
                e.width = Math.max(e.width, p.dx + p.dw);
                e.height = Math.max(e.height, p.dy + p.dh);
                e.instructions.push(p);
                nt();
            }
        } catch {}
        return r;
    };

    window.addEventListener("message", e => {
        if (!e.data) return;
        if (e.data === "REQUEST_CANVAS_MAP") nt();
        if (e.data === "ENABLE_BLOB_HOOK") bh = true;
        if (e.data === "REQUEST_BLOB_URLS") window.postMessage({ type: "BLOB_URLS_RESPONSE", urls: b }, "*");
        if (e.data.type === "PAGE_CONVERT_BLOB") {
            const u = e.data.url;
            const cb = bc[u];
            const cv = blob => {
                const r = new FileReader();
                r.onloadend = () => window.postMessage({ type: "PAGE_BLOB_CONVERTED", url: u, dataUrl: r.result }, "*");
                r.readAsDataURL(blob);
            };
            if (cb) cv(cb);
            else fetch(u).then(r => r.blob()).then(blob => cv(blob)).catch(() => window.postMessage({ type: "PAGE_BLOB_CONVERTED", url: u, error: true }, "*"));
        }
    });
})();
