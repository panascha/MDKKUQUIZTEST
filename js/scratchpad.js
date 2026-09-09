// scratchpad.js — Scratchpad / Apple Pencil: เขียนบนการ์ดโจทย์ได้เลย (Phase 1: engine + persistence + PDF ; Phase 1b: ฝน badge เลือกคำตอบ)
// ลายเส้นผูกกับ element ที่เริ่มวาด (anchor) และเก็บพิกัดแบบ normalize ต่อความกว้างของ element นั้น
// → การ์ดสูงขึ้น/ตัวเลือกสลับที่/รูปโหลดช้า ลายเส้นก็ยังตามเนื้อหาเดิม (ดู Idea/active/scratchpad-apple-pencil-plan.md §3)
//
// anchor: 'question' (#question) | 'qimage' (#image-container-div) | 'choice:<oidx>' (ปุ่มตัวเลือกตาม data-oidx) | 'card' (พื้นที่ว่าง)
// stroke: { tool:'pen'|'highlighter', style?, color, width, aw, anchor, points:[{nx,ny,p?}], causedSelection? } — aw = ความกว้าง anchor ตอนวาด (px) ใช้สเกลความหนา
//   style: 'ball'|'fountain'|'brush' (Phase 2, pen เท่านั้น) — stroke เก่าไม่มี field นี้ → ถือเป็น 'ball' ตอนวาด ไม่ migrate DB
//   p: แรงกดจาก Apple Pencil (0–1) มีเฉพาะ pointerType 'pen' — ไม่มี p (นิ้ว/เมาส์/stroke เก่า) → perfect-freehand จำลองแรงกดจากความเร็ว
//   causedSelection: { qid, previousSelectedAnswer, newSelectedAnswer } เฉพาะ stroke ที่ฝน badge จนเปลี่ยนคำตอบ (undo คืนค่าเดิม)
// IndexedDB key: scratch_<subjectParam>_<qid> → { qid, subjectParam, strokes, redoStack, updatedAt }
// localStorage: scratchpad_prefs → { penStyle, pen:{colors,widths,ci,wi}, hl:{...}, eraseHlOnly } (Phase 2 §8 Q15/Q17 — ไม่จำ tool)

(function () {
    var HL_ALPHA = 0.45;
    var PREFS_KEY = 'scratchpad_prefs';
    // Q15: preset สี/ความหนา 3 ช่อง — ปากกากับไฮไลต์แยกชุด ; ci/wi = ช่องที่เลือก ; กดค้างที่จุด/pill แก้ค่าในช่องได้ (popover)
    var DEFAULT_PREFS = {
        penStyle: 'ball',
        pen: { colors: ['#2563eb', '#1e1e1e', '#dc2626'], widths: [1.5, 2.5, 5], ci: 0, wi: 1 },
        hl:  { colors: ['#facc15', '#4ade80', '#f472b6'], widths: [12, 18, 28],  ci: 0, wi: 1 },
        eraseHlOnly: false           // step 4 (Q11) ต่อเข้า canEraseStroke — ตอนนี้แค่จำค่า
    };
    var WIDTH_RANGE = { pen: [0.5, 12], hl: [6, 40] };   // ช่วง slider ใน popover
    var LONG_PRESS_MS = 500;
    var ERASER_RADIUS = 12;          // px
    var DECIMATE_SQ = 4;             // R6: ข้ามจุดที่ห่างจากจุดก่อน < 2px
    var PALM_BLOB_PX = 40;           // นิ้ว/ฝ่ามือกว้างเกินนี้ = ฝ่ามือ ไม่วาด
    var SAVE_DEBOUNCE_MS = 300;
    var TOOLBAR_COLLAPSED_KEY = 'scratchpad_toolbar_collapsed';
    // Phase 1b: ฝนวงกลม .choice-badge เพื่อเลือกคำตอบ — แยกจาก window.OMR_CONFIG (นั่นของกระดาษ OMR/grader.js)
    var CHOICE_BADGE_RADIUS = 18;    // px รัศมีเป้ารอบจุดกลาง badge (badge กว้าง 30px + เผื่อขอบ)
    var SHADE_COMMIT_FACTOR = 2.5;   // ความยาวเส้นสะสมใน badge ≥ factor × เส้นผ่านศูนย์กลาง → เลือก (≈ ฝน 4 รอบ)
    // Phase 2 §8 Q1–Q2b: ปากกาทุกแบบวาดผ่าน perfect-freehand — ball thinning:0 = ความหนาคงที่เท่า Phase 1 เป๊ะ
    var PEN_STYLES = {
        ball:     { thinning: 0,    smoothing: 0.5, streamline: 0.5 },
        fountain: { thinning: 0.6,  smoothing: 0.5, streamline: 0.5 },
        brush:    { thinning: 0.75, smoothing: 0.6, streamline: 0.4, start: { taper: 20 }, end: { taper: 20 } }
    };
    var outlineCache = new WeakMap();  // stroke → { w, path } — outline คำนวณแพง ไม่ต้องทำซ้ำทุกเฟรมตอนลากเส้นใหม่

    var wrapper, canvas, ctx, offscreen, offCtx, toolbar;
    var tool = 'pen';
    var prefs = loadPrefs();
    var popTarget = null;            // popover เปิดอยู่ที่ { kind:'color'|'width', idx }
    var swallowPresetClick = false;  // click ที่ตามหลังกดค้าง (touch) ห้ามไปปิด popover ที่เพิ่งเปิด
    var dpr = 1;
    var active = null;               // stroke ที่กำลังลาก
    var activeMeta = null;           // { pointerId, wrapLeft, wrapTop, ax, ay, aw, lastX, lastY, badges }
    var rafPending = false;
    var saveTimer = null;
    var loadSeq = 0;
    var suppressClickUntil = 0;

    function subjectParam() {
        return new URLSearchParams(window.location.search).get('subject') || 'default';
    }
    function scratchKey(sp, qid) { return 'scratch_' + sp + '_' + qid; }

    function state() { return window.APP._scratchpadState; }

    // ─── Prefs (Q17) ─────────────────────────────────────────
    // อ่านทับ default ทีละ field — JSON เก่า/พังไม่ทำให้ toolbar ตาย
    function loadPrefs() {
        var p = JSON.parse(JSON.stringify(DEFAULT_PREFS));
        try {
            var s = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
            if (!s || typeof s !== 'object') return p;
            if (PEN_STYLES[s.penStyle]) p.penStyle = s.penStyle;
            if (typeof s.eraseHlOnly === 'boolean') p.eraseHlOnly = s.eraseHlOnly;
            ['pen', 'hl'].forEach(function (k) {
                var d = p[k], o = s[k];
                if (!o || typeof o !== 'object') return;
                for (var i = 0; i < 3; i++) {
                    if (o.colors && /^#[0-9a-f]{6}$/i.test(o.colors[i])) d.colors[i] = o.colors[i];
                    if (o.widths && isFinite(o.widths[i]) && o.widths[i] > 0) d.widths[i] = Number(o.widths[i]);
                }
                if (o.ci >= 0 && o.ci <= 2) d.ci = o.ci | 0;
                if (o.wi >= 0 && o.wi <= 2) d.wi = o.wi | 0;
            });
        } catch (e) { }
        return p;
    }
    function savePrefs() {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { }
    }
    function presetGroup() { return tool === 'highlighter' ? prefs.hl : prefs.pen; }

    // ─── Anchor ───────────────────────────────────────────────
    function anchorFromTarget(target) {
        var btn = target.closest('#choices button');
        if (btn && btn.dataset.oidx !== undefined) return 'choice:' + btn.dataset.oidx;
        if (target.closest('#question')) return 'question';
        if (target.closest('#image-container-div')) return 'qimage';
        return 'card';
    }
    function resolveAnchor(anchor) {
        if (anchor === 'card') return wrapper;
        if (anchor === 'question') return document.getElementById('question');
        if (anchor === 'qimage') return document.getElementById('image-container-div');
        if (anchor.indexOf('choice:') === 0) {
            return document.querySelector('#choices button[data-oidx="' + anchor.slice(7) + '"]');
        }
        return null;
    }
    // rect ของ anchor เทียบมุมซ้ายบนของ wrapper — null ถ้า element ไม่อยู่/ซ่อน (เช่น #choices.meq-hidden)
    function anchorRect(anchor) {
        var el = resolveAnchor(anchor);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        var w = wrapper.getBoundingClientRect();
        return { x: r.left - w.left, y: r.top - w.top, w: r.width };
    }

    // ─── Canvas ───────────────────────────────────────────────
    function resizeCanvas() {
        var r = wrapper.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        dpr = window.devicePixelRatio || 1;
        var W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W; canvas.height = H;
            offscreen.width = W; offscreen.height = H;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return true;
    }

    function blendMode() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'screen' : 'multiply';
    }

    function strokePath(c, stroke, rect) {
        var pts = stroke.points;
        if (!pts.length) return;
        var s = rect.w / (stroke.aw || rect.w);
        c.beginPath();
        c.lineCap = 'round';
        c.lineJoin = 'round';
        c.lineWidth = stroke.width * s;
        c.strokeStyle = stroke.color;
        c.moveTo(rect.x + pts[0].nx * rect.w, rect.y + pts[0].ny * rect.w);
        for (var i = 1; i < pts.length; i++) c.lineTo(rect.x + pts[i].nx * rect.w, rect.y + pts[i].ny * rect.w);
        if (pts.length === 1) c.lineTo(rect.x + pts[0].nx * rect.w + 0.01, rect.y + pts[0].ny * rect.w);
        c.stroke();
    }

    // perfect-freehand: จุด normalize → px แล้วขอ outline polygon มา fill (ไม่ใช่ stroke เส้นกลาง) ; stroke ที่ commit แล้ว cache path ไว้
    function penOutline(stroke, rect, isActive) {
        var cached = !isActive && outlineCache.get(stroke);
        if (cached && cached.w === rect.w) return cached.path;
        var pts = stroke.points;
        var s = rect.w / (stroke.aw || rect.w);
        var input = new Array(pts.length);
        for (var i = 0; i < pts.length; i++) {
            input[i] = [rect.x + pts[i].nx * rect.w, rect.y + pts[i].ny * rect.w, pts[i].p === undefined ? 0.5 : pts[i].p];
        }
        var opts = Object.assign({}, PEN_STYLES[stroke.style] || PEN_STYLES.ball, {
            size: stroke.width * s,
            simulatePressure: pts[0].p === undefined,
            last: !isActive
        });
        var outline = window.PerfectFreehand.getStroke(input, opts);
        var path = new Path2D();
        if (outline.length) {
            path.moveTo(outline[0][0], outline[0][1]);
            for (var j = 1; j < outline.length; j++) path.lineTo(outline[j][0], outline[j][1]);
            path.closePath();
        }
        if (!isActive) outlineCache.set(stroke, { w: rect.w, path: path });
        return path;
    }
    function fillPen(c, stroke, rect, isActive) {
        if (!stroke.points.length) return;
        c.fillStyle = stroke.color;
        c.fill(penOutline(stroke, rect, isActive));
    }

    // R2: ปากกาเน้น วาดลง offscreen ก่อน (ไม่ blend) แล้วค่อย composite ทีเดียว → รอยต่อระหว่าง segment ไม่เข้มซ้อน
    function drawStroke(stroke, rect, isActive) {
        if (stroke.tool === 'highlighter') {
            offCtx.clearRect(0, 0, canvas.width, canvas.height);
            offCtx.globalAlpha = HL_ALPHA;
            strokePath(offCtx, stroke, rect);
            offCtx.globalAlpha = 1;
            ctx.save();
            ctx.globalCompositeOperation = blendMode();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(offscreen, 0, 0);
            ctx.restore();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else {
            fillPen(ctx, stroke, rect, isActive);
        }
    }

    function renderAll() {
        if (!resizeCanvas()) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var st = state();
        if (!st) return;
        var rects = {};
        st.strokes.forEach(function (stroke) {
            if (!(stroke.anchor in rects)) rects[stroke.anchor] = anchorRect(stroke.anchor);
            var rect = rects[stroke.anchor];
            if (rect) drawStroke(stroke, rect);
        });
        if (active && activeMeta) drawStroke(active, { x: activeMeta.ax, y: activeMeta.ay, w: activeMeta.aw }, true);
    }

    var resizeTimer = null;
    function scheduleRender() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderAll, 60);
    }

    // ─── Persistence ─────────────────────────────────────────
    function deleteCacheDB(key) {
        return window.openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('quiz_cache', 'readwrite');
                tx.objectStore('quiz_cache').delete(key);
                tx.oncomplete = resolve;
                tx.onerror = function (e) { reject(e.target.error); };
            });
        });
    }

    function persist(st) {
        if (!st || !st.qid) return Promise.resolve();
        var key = scratchKey(st.subjectParam, st.qid);
        if (!st.strokes.length && !st.redoStack.length) return deleteCacheDB(key).catch(function () { });
        return window.setCacheDB(key, {
            qid: st.qid, subjectParam: st.subjectParam,
            strokes: st.strokes, redoStack: st.redoStack, updatedAt: Date.now()
        }).catch(function (e) { console.warn('[Scratchpad] save failed', e); });
    }

    function markDirty() {
        clearTimeout(saveTimer);
        var st = state();
        saveTimer = setTimeout(function () { persist(st); }, SAVE_DEBOUNCE_MS);
        updateToolbarState();
    }

    function flush() {
        clearTimeout(saveTimer);
        return persist(state());
    }

    function loadForQuestion(qid) {
        var sp = subjectParam();
        var seq = ++loadSeq;
        window.APP._scratchpadState = { qid: qid, subjectParam: sp, strokes: [], redoStack: [] };
        renderAll();
        updateToolbarState();
        window.getCacheDB(scratchKey(sp, qid)).then(function (rec) {
            if (seq !== loadSeq || !rec) return;
            var st = state();
            // ผู้ใช้อาจวาดไปแล้วระหว่างรอโหลด — เอาของเก่าไว้ก่อน ต่อด้วยของใหม่
            st.strokes = (rec.strokes || []).concat(st.strokes);
            if (!st.redoStack.length) st.redoStack = rec.redoStack || [];
            renderAll();
            updateToolbarState();
        }).catch(function (e) { console.warn('[Scratchpad] load failed', e); });
    }

    // ─── Eraser (R3: ระยะจุด→segment ไม่ใช่จุด→จุด) ─────────
    function pointToSegmentDist(px, py, x1, y1, x2, y2) {
        var dx = x2 - x1, dy = y2 - y1;
        var lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - x1, py - y1);
        var t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    function strokeHit(stroke, rect, px, py) {
        var pts = stroke.points;
        var s = rect.w / (stroke.aw || rect.w);
        var thr = ERASER_RADIUS + (stroke.width * s) / 2;
        if (pts.length === 1) {
            return Math.hypot(px - (rect.x + pts[0].nx * rect.w), py - (rect.y + pts[0].ny * rect.w)) < thr;
        }
        for (var i = 0; i < pts.length - 1; i++) {
            if (pointToSegmentDist(px, py,
                rect.x + pts[i].nx * rect.w, rect.y + pts[i].ny * rect.w,
                rect.x + pts[i + 1].nx * rect.w, rect.y + pts[i + 1].ny * rect.w) < thr) return true;
        }
        return false;
    }
    function eraseAt(px, py) {
        var st = state();
        if (!st) return;
        var rects = {};
        var before = st.strokes.length;
        st.strokes = st.strokes.filter(function (stroke) {
            if (!(stroke.anchor in rects)) rects[stroke.anchor] = anchorRect(stroke.anchor);
            var rect = rects[stroke.anchor];
            return !rect || !strokeHit(stroke, rect, px, py);
        });
        if (st.strokes.length !== before) { renderAll(); markDirty(); }
    }

    // ─── Bubble-fill: ฝน .choice-badge → เลือกคำตอบ (§6 Q1–Q4) ─
    function canShadeSelect() {
        var q = window.APP.current_question;
        return !!q && q.state !== true;
    }
    // snapshot เป้า badge ตอน pointerdown — ข้าม badge ที่ซ่อน (MEQ: #choices.meq-hidden → rect 0) และตัวเลือกที่จางใน Fast Mode
    function collectBadges(wrapLeft, wrapTop) {
        var out = [];
        document.querySelectorAll('#choices button .choice-badge').forEach(function (el) {
            var btn = el.closest('button');
            if (!btn || btn.classList.contains('faded-choice')) return;
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            out.push({ el: el, btn: btn, cx: r.left + r.width / 2 - wrapLeft, cy: r.top + r.height / 2 - wrapTop, d: r.width, len: 0 });
        });
        return out;
    }
    function accumulateShade(x1, y1, x2, y2) {
        var badges = activeMeta.badges;
        if (!badges || !badges.length) return;
        var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        var seg = Math.hypot(x2 - x1, y2 - y1);
        var top = null;
        badges.forEach(function (b) {
            if (Math.hypot(mx - b.cx, my - b.cy) <= CHOICE_BADGE_RADIUS) b.len += seg;
            if (!top || b.len > top.len) top = b;
        });
        badges.forEach(function (b) {
            b.el.classList.toggle('shading', b === top && b.len >= b.d * SHADE_COMMIT_FACTOR);
        });
    }
    function clearShadingClass() {
        document.querySelectorAll('#choices .choice-badge.shading').forEach(function (el) { el.classList.remove('shading'); });
    }
    function selectedAnswer() {
        var b = document.querySelector('#choices button.selected');
        return b ? b.getAttribute('data-answer') : null;
    }
    function applySelection(answer) {
        if (!canShadeSelect()) return;
        var btns = document.querySelectorAll('#choices button');
        btns.forEach(function (b) {
            b.classList.toggle('selected', answer !== null && b.getAttribute('data-answer') === answer);
        });
    }
    // winner-takes-all ตอนปล่อยปากกา — คืน tag ให้ stroke ถ้าเปลี่ยนคำตอบ ไม่งั้น null
    function commitShade() {
        var badges = activeMeta.badges;
        if (!badges || !badges.length || !canShadeSelect()) return null;
        var top = null;
        badges.forEach(function (b) { if (!top || b.len > top.len) top = b; });
        if (!top || top.len < top.d * SHADE_COMMIT_FACTOR) return null;
        var prev = selectedAnswer();
        var next = top.btn.getAttribute('data-answer');
        if (prev === next) return null;
        applySelection(next);
        return { qid: window.APP.current_question.questionId, previousSelectedAnswer: prev, newSelectedAnswer: next };
    }
    function restoreSelection(stroke, key) {
        var cs = stroke && stroke.causedSelection;
        if (!cs) return;
        var q = window.APP.current_question;
        if (!q || q.questionId !== cs.qid) return;
        applySelection(cs[key]);
    }

    // ─── Pointer router ──────────────────────────────────────
    function wantsDraw(e) {
        if (e.pointerType === 'pen') return true;
        if (e.pointerType === 'touch' && window.APP._fingerDrawMode) return e.width < PALM_BLOB_PX && e.height < PALM_BLOB_PX;
        if (e.pointerType === 'mouse' && window.APP._fingerDrawMode) return true;
        return false;
    }

    function onPointerDown(e) {
        if (active || !state()) return;
        if (wrapper.classList.contains('scratchpad-disabled')) return;
        if (!wantsDraw(e)) return;
        // Q7: textarea/input ปล่อยผ่าน — Apple Scribble + วางเคอร์เซอร์ใน MEQ textarea ต้องใช้ได้
        if (e.target.closest('textarea, input, [contenteditable]')) return;
        if (!resizeCanvas()) return;

        var w = wrapper.getBoundingClientRect();
        var px = e.clientX - w.left, py = e.clientY - w.top;

        if (tool === 'eraser') {
            activeMeta = { pointerId: e.pointerId, wrapLeft: w.left, wrapTop: w.top, erasing: true };
            beginCapture(e);
            eraseAt(px, py);
            return;
        }

        var anchor = anchorFromTarget(e.target);
        var rect = anchorRect(anchor);
        if (!rect) { anchor = 'card'; rect = anchorRect('card'); }
        var pg = presetGroup();
        active = {
            tool: tool,
            color: pg.colors[pg.ci],
            width: pg.widths[pg.wi],
            aw: rect.w,
            anchor: anchor,
            points: []
        };
        if (tool === 'pen') active.style = prefs.penStyle;
        activeMeta = {
            pointerId: e.pointerId, wrapLeft: w.left, wrapTop: w.top, ax: rect.x, ay: rect.y, aw: rect.w, lastX: px, lastY: py,
            badges: canShadeSelect() ? collectBadges(w.left, w.top) : [],
            pressure: e.pointerType === 'pen'
        };
        active.points.push(makePoint(px, py, e));
        beginCapture(e);
        requestRender();
    }

    // Q2: เก็บ p เฉพาะ Pencil — นิ้ว/เมาส์ไม่มี p ให้ perfect-freehand จำลองจากความเร็ว (simulatePressure)
    function makePoint(px, py, e) {
        var pt = { nx: (px - activeMeta.ax) / activeMeta.aw, ny: (py - activeMeta.ay) / activeMeta.aw };
        if (activeMeta.pressure) pt.p = e.pressure;
        return pt;
    }

    function beginCapture(e) {
        e.preventDefault();
        canvas.style.pointerEvents = 'auto';
        wrapper.classList.add('scratchpad-drawing');
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
    }

    function onPointerMove(e) {
        if (!activeMeta || e.pointerId !== activeMeta.pointerId) return;
        var px = e.clientX - activeMeta.wrapLeft, py = e.clientY - activeMeta.wrapTop;
        if (activeMeta.erasing) { eraseAt(px, py); return; }
        var dx = px - activeMeta.lastX, dy = py - activeMeta.lastY;
        if (dx * dx + dy * dy < DECIMATE_SQ) return;
        accumulateShade(activeMeta.lastX, activeMeta.lastY, px, py);
        activeMeta.lastX = px; activeMeta.lastY = py;
        active.points.push(makePoint(px, py, e));
        requestRender();
    }

    function onPointerEnd(e) {
        if (!activeMeta || e.pointerId !== activeMeta.pointerId) return;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { }
        canvas.style.pointerEvents = 'none';
        wrapper.classList.remove('scratchpad-drawing');
        suppressClickUntil = Date.now() + 400;

        if (active) {
            if (e.type !== 'pointercancel') {
                // R6: จุดสุดท้ายเก็บเสมอ ไม่ผ่าน decimation
                var px = e.clientX - activeMeta.wrapLeft, py = e.clientY - activeMeta.wrapTop;
                accumulateShade(activeMeta.lastX, activeMeta.lastY, px, py);
                active.points.push(makePoint(px, py, e));
                var caused = commitShade();
                if (caused) active.causedSelection = caused;
                var st = state();
                st.strokes.push(active);
                st.redoStack = [];
                markDirty();
            }
            active = null;
        }
        clearShadingClass();
        activeMeta = null;
        renderAll();
    }

    function requestRender() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(function () { rafPending = false; renderAll(); });
    }

    // iOS Safari: touch-action ไม่แยกปากกากับนิ้ว — กันหน้าเลื่อนตอนใช้ Pencil ผ่าน touchstart/touchmove แทน
    function onTouchGuard(e) {
        var t = e.touches[0];
        if (!t) return;
        if (t.touchType === 'stylus' || window.APP._fingerDrawMode) {
            if (e.target.closest('textarea, input, [contenteditable]')) return;
            if (wrapper.classList.contains('scratchpad-disabled')) return;
            e.preventDefault();
        }
    }

    // ─── Undo / Redo / Clear ─────────────────────────────────
    // Q4: stroke ที่ทำให้เลือกคำตอบ undo แล้วคืนคำตอบเดิม / redo เลือกกลับ ; clearAll ลบเฉพาะลายเส้น ไม่แตะคำตอบ
    function undo() {
        var st = state();
        if (!st || !st.strokes.length) return;
        var s = st.strokes.pop();
        st.redoStack.push(s);
        restoreSelection(s, 'previousSelectedAnswer');
        renderAll(); markDirty();
    }
    function redo() {
        var st = state();
        if (!st || !st.redoStack.length) return;
        var s = st.redoStack.pop();
        st.strokes.push(s);
        restoreSelection(s, 'newSelectedAnswer');
        renderAll(); markDirty();
    }
    function clearAll() {
        var st = state();
        if (!st || (!st.strokes.length && !st.redoStack.length)) return;
        Swal.fire({
            title: 'ล้างลายเส้นของข้อนี้?',
            text: 'ลบเฉพาะที่เขียนไว้ในข้อนี้ ข้ออื่นไม่กระทบ',
            icon: 'warning', showCancelButton: true,
            confirmButtonText: 'ล้าง', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#d33'
        }).then(function (r) {
            if (!r.isConfirmed) return;
            st.strokes = []; st.redoStack = [];
            renderAll(); markDirty();
        });
    }

    // ─── Toolbar ─────────────────────────────────────────────
    // Q13: ปุ่ม Ball/Fountain/Brush = tool 'pen' + data-sp-style — คลิกเดียวตั้งทั้งคู่ ; แบบปากกาจำใน prefs
    function setTool(t, style) {
        tool = t;
        if (t === 'pen' && PEN_STYLES[style]) { prefs.penStyle = style; savePrefs(); }
        toolbar.querySelectorAll('.sp-tool').forEach(function (b) {
            var on = b.dataset.spTool === t && (t !== 'pen' || b.dataset.spStyle === prefs.penStyle);
            b.classList.toggle('active', on);
        });
        hidePopover();
        renderCtxRow();
    }
    // แถว 2 ตามเครื่องมือ: ปากกา/ไฮไลต์ = จุดสี + pill ความหนา ; ยางลบ = checkbox ; อื่นๆ ซ่อนทั้งแถว
    function renderCtxRow() {
        var hasPresets = tool === 'pen' || tool === 'highlighter';
        toolbar.querySelector('.sp-row-ctx').hidden = !hasPresets && tool !== 'eraser';
        toolbar.querySelector('.sp-presets').hidden = !hasPresets;
        toolbar.querySelector('.sp-eraser-opt').hidden = tool !== 'eraser';
        if (hasPresets) {
            var pg = presetGroup();
            var scale = tool === 'highlighter' ? 1 / 3 : 1;   // เส้น preview ใน pill (ไฮไลต์หนามาก ย่อให้พอดี)
            toolbar.querySelectorAll('.sp-dot').forEach(function (d, i) {
                d.style.background = pg.colors[i];
                d.classList.toggle('active', i === pg.ci);
            });
            toolbar.querySelectorAll('.sp-pill').forEach(function (p, i) {
                var line = p.querySelector('.sp-pill-line');
                if (line) line.style.height = Math.max(1.5, Math.min(10, pg.widths[i] * scale)) + 'px';
                p.classList.toggle('active', i === pg.wi);
            });
        }
        var cb = document.getElementById('sp-erase-hl-only');
        if (cb) cb.checked = !!prefs.eraseHlOnly;
    }
    // Popover แก้ค่าในช่อง (กดค้าง/คลิกขวาที่จุดหรือ pill) — input native: color picker / range
    function showPopover(kind, idx) {
        var pop = toolbar.querySelector('.sp-popover');
        var pg = presetGroup();
        popTarget = { kind: kind, idx: idx };
        pop.querySelector('.sp-pop-color-wrap').hidden = kind !== 'color';
        pop.querySelector('.sp-pop-width-wrap').hidden = kind !== 'width';
        if (kind === 'color') {
            document.getElementById('sp-pop-color').value = pg.colors[idx];
        } else {
            var r = document.getElementById('sp-pop-width');
            var rng = WIDTH_RANGE[tool === 'highlighter' ? 'hl' : 'pen'];
            r.min = rng[0]; r.max = rng[1]; r.value = pg.widths[idx];
            document.getElementById('sp-pop-width-val').textContent = pg.widths[idx] + 'px';
        }
        pop.hidden = false;
    }
    function hidePopover() {
        var pop = toolbar.querySelector('.sp-popover');
        if (pop) pop.hidden = true;
        popTarget = null;
    }
    function onPopoverInput(e) {
        if (!popTarget) return;
        var pg = presetGroup();
        if (popTarget.kind === 'color') {
            pg.colors[popTarget.idx] = e.target.value;
            pg.ci = popTarget.idx;
        } else {
            var v = parseFloat(e.target.value);
            if (!(v > 0)) return;
            pg.widths[popTarget.idx] = v;
            pg.wi = popTarget.idx;
            document.getElementById('sp-pop-width-val').textContent = v + 'px';
        }
        savePrefs();
        renderCtxRow();
    }
    function presetTarget(el) {
        var b = el.closest('.sp-dot, .sp-pill');
        if (!b) return null;
        return b.classList.contains('sp-dot') ? { kind: 'color', idx: +b.dataset.spCi } : { kind: 'width', idx: +b.dataset.spWi };
    }
    // กดค้าง 500ms ที่จุด/pill → popover ; ขยับเกิน 8px (เลื่อนแถวบนมือถือ) หรือปล่อยก่อน = ยกเลิก
    function initLongPress() {
        var timer = null, sx = 0, sy = 0;
        function cancel() { if (timer) clearTimeout(timer); timer = null; }
        toolbar.addEventListener('pointerdown', function (e) {
            var t = presetTarget(e.target);
            if (!t) return;
            cancel();
            sx = e.clientX; sy = e.clientY;
            timer = setTimeout(function () { timer = null; swallowPresetClick = true; showPopover(t.kind, t.idx); }, LONG_PRESS_MS);
        });
        toolbar.addEventListener('pointermove', function (e) {
            if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
        });
        toolbar.addEventListener('pointerup', cancel);
        toolbar.addEventListener('pointercancel', cancel);
        toolbar.addEventListener('contextmenu', function (e) {
            var t = presetTarget(e.target);
            if (!t) return;
            e.preventDefault();
            cancel();
            showPopover(t.kind, t.idx);
        });
    }
    function updateToolbarState() {
        var st = state();
        var u = toolbar.querySelector('[data-sp-act="undo"]');
        var r = toolbar.querySelector('[data-sp-act="redo"]');
        var c = toolbar.querySelector('[data-sp-act="clear"]');
        if (u) u.disabled = !st || !st.strokes.length;
        if (r) r.disabled = !st || !st.redoStack.length;
        if (c) c.disabled = !st || (!st.strokes.length && !st.redoStack.length);
    }
    function setFingerMode(on) {
        window.APP._fingerDrawMode = on;
        wrapper.classList.toggle('scratchpad-finger', on);
        var b = toolbar.querySelector('[data-sp-act="finger"]');
        if (b) b.classList.toggle('active', on);
    }

    function initToolbar() {
        var toggle = document.getElementById('scratchpad-toolbar-toggle');
        toolbar.addEventListener('click', function (e) {
            if (swallowPresetClick) { swallowPresetClick = false; return; }
            if (!e.target.closest('.sp-popover')) hidePopover();
            var pt = presetTarget(e.target);
            if (pt) {
                var pg = presetGroup();
                if (pt.kind === 'color') pg.ci = pt.idx; else pg.wi = pt.idx;
                savePrefs(); renderCtxRow();
                return;
            }
            var btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.spTool) { setTool(btn.dataset.spTool, btn.dataset.spStyle); return; }
            switch (btn.dataset.spAct) {
                case 'undo': undo(); break;
                case 'redo': redo(); break;
                case 'clear': clearAll(); break;
                case 'finger': setFingerMode(!window.APP._fingerDrawMode); break;
            }
        });
        toolbar.querySelector('.sp-popover').addEventListener('input', onPopoverInput);
        document.getElementById('sp-erase-hl-only').addEventListener('change', function (e) {
            prefs.eraseHlOnly = e.target.checked;
            savePrefs();
        });
        initLongPress();
        setTool('pen', prefs.penStyle);
        updateToolbarState();

        // R7: จอเล็กยุบเป็นปุ่มกลม จำสถานะไว้ใน localStorage ; จอใหญ่ CSS แสดงเต็มเสมอ (class ไม่มีผล)
        var collapsed = true;
        try { collapsed = localStorage.getItem(TOOLBAR_COLLAPSED_KEY) !== 'false'; } catch (e) { }
        toolbar.classList.toggle('collapsed', collapsed);
        toggle.addEventListener('click', function () {
            var c = toolbar.classList.toggle('collapsed');
            if (c) hidePopover();
            try { localStorage.setItem(TOOLBAR_COLLAPSED_KEY, String(c)); } catch (e) { }
        });
        document.addEventListener('click', function (e) {
            if (toolbar.contains(e.target) || e.target === toggle || toggle.contains(e.target)) return;
            hidePopover();
            if (window.innerWidth >= 768) return;
            if (toolbar.classList.contains('collapsed')) return;
            toolbar.classList.add('collapsed');
            try { localStorage.setItem(TOOLBAR_COLLAPSED_KEY, 'true'); } catch (err) { }
        });
    }

    // ─── Modal guard: มี .modal-card เปิดอยู่ → ปิด overlay ─────
    function initModalGuard() {
        var modals = document.querySelectorAll('.modal-card');
        if (!modals.length) return;
        function check() {
            var open = false;
            modals.forEach(function (m) { if (getComputedStyle(m).display !== 'none') open = true; });
            wrapper.classList.toggle('scratchpad-disabled', open);
        }
        var mo = new MutationObserver(check);
        modals.forEach(function (m) { mo.observe(m, { attributes: true, attributeFilter: ['style', 'class'] }); });
        check();
    }

    // ─── PDF (ใช้โดย pdf-generator.js saveResultsToPdf) ──────
    // วาด strokes ของ anchor ที่กำหนดลง jsPDF ในกรอบ (x, y, w) หน่วย mm — พิกัดปกติเทียบความกว้างเหมือนบนจอ
    window.drawScratchStrokesToPdf = function (doc, strokes, anchor, x, y, w) {
        if (!strokes || !strokes.length) return;
        strokes.forEach(function (stroke) {
            if (stroke.anchor !== anchor || !stroke.points.length) return;
            var pts = stroke.points;
            var hl = stroke.tool === 'highlighter';
            var rgb = hexToRgb(stroke.color);
            doc.saveGraphicsState();
            if (hl && typeof doc.GState === 'function') doc.setGState(new doc.GState({ opacity: HL_ALPHA }));
            doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
            // ความหนาสเกลตามความกว้าง anchor เหมือนบนจอ: px ต้นทาง → mm ผ่านอัตราส่วน w/aw
            doc.setLineWidth(stroke.width * w / (stroke.aw || 400));
            doc.setLineCap(1); doc.setLineJoin(1);
            var x0 = x + pts[0].nx * w, y0 = y + pts[0].ny * w;
            if (pts.length === 1) {
                doc.line(x0, y0, x0 + 0.01, y0);
            } else {
                var segs = [];
                for (var i = 1; i < pts.length; i++) {
                    segs.push([(pts[i].nx - pts[i - 1].nx) * w, (pts[i].ny - pts[i - 1].ny) * w]);
                }
                doc.lines(segs, x0, y0, [1, 1], 'S', false);
            }
            doc.restoreGraphicsState();
        });
    };
    function hexToRgb(hex) {
        var n = parseInt(hex.replace('#', ''), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    // ─── Init ────────────────────────────────────────────────
    $(function () {
        wrapper = document.getElementById('quiz-card-wrapper');
        canvas = document.getElementById('quiz-annotation-canvas');
        toolbar = document.getElementById('scratchpad-toolbar');
        if (!wrapper || !canvas || !toolbar) return;
        ctx = canvas.getContext('2d');
        offscreen = document.createElement('canvas');
        offCtx = offscreen.getContext('2d');

        wrapper.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerEnd);
        canvas.addEventListener('pointercancel', onPointerEnd);
        wrapper.addEventListener('touchstart', onTouchGuard, { passive: false });
        wrapper.addEventListener('touchmove', onTouchGuard, { passive: false });
        // click ที่หลุดมาหลังยกปากกา (เช่น ตอน capture ล้มเหลวบน WebKit) ห้ามไปกดตัวเลือก
        wrapper.addEventListener('click', function (e) {
            if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
        }, true);

        new ResizeObserver(scheduleRender).observe(wrapper);
        window.addEventListener('resize', scheduleRender);

        initToolbar();
        initModalGuard();
    });

    // Hook showQuestion: flush ข้อเก่า โหลดลายเส้นข้อใหม่ (decorator pattern เหมือน meq.js/glossary.js)
    (function () {
        var _orig = window.showQuestion;
        if (typeof _orig !== 'function') {
            console.warn('[Scratchpad] window.showQuestion not found at hook time');
            return;
        }
        window.showQuestion = function (shouldFocus) {
            _orig.call(this, shouldFocus);
            if (!wrapper) return;
            var q = window.APP.current_question;
            var qid = q && q.questionId;
            if (!qid) return;
            var st = state();
            if (st && st.qid === qid && st.subjectParam === subjectParam()) { scheduleRender(); return; }
            if (st) flush();
            loadForQuestion(qid);
        };
    })();
})();
