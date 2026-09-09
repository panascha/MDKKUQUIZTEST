// scratchpad.js — Scratchpad / Apple Pencil: เขียนบนการ์ดโจทย์ได้เลย (Phase 1: engine + persistence + PDF ; Phase 1b: ฝน badge เลือกคำตอบ)
// ลายเส้นผูกกับ element ที่เริ่มวาด (anchor) และเก็บพิกัดแบบ normalize ต่อความกว้างของ element นั้น
// → การ์ดสูงขึ้น/ตัวเลือกสลับที่/รูปโหลดช้า ลายเส้นก็ยังตามเนื้อหาเดิม (ดู Idea/active/scratchpad-apple-pencil-plan.md §3)
//
// anchor: 'question' (#question) | 'qimage' (#image-container-div) | 'choice:<oidx>' (ปุ่มตัวเลือกตาม data-oidx) | 'card' (พื้นที่ว่าง)
// stroke: { tool:'pen'|'highlighter', style?, color, width, aw, anchor, points:[{nx,ny,p?}], shapeType?, causedSelection? } — aw = ความกว้าง anchor ตอนวาด (px) ใช้สเกลความหนา
//   shapeType: 'line'|'ellipse'|'rect' เฉพาะ stroke ที่วาดค้างจน snap (Phase 2 Q8) — points เป็นเส้นสังเคราะห์แล้ว renderer ไม่ต้องรู้
//   style: 'ball'|'fountain'|'brush' (Phase 2, pen เท่านั้น) — stroke เก่าไม่มี field นี้ → ถือเป็น 'ball' ตอนวาด ไม่ migrate DB
//   p: แรงกดจาก Apple Pencil (0–1) มีเฉพาะ pointerType 'pen' — ไม่มี p (นิ้ว/เมาส์/stroke เก่า) → perfect-freehand จำลองแรงกดจากความเร็ว
//   causedSelection: { qid, previousSelectedAnswer, newSelectedAnswer } เฉพาะ stroke ที่ฝน badge จนเปลี่ยนคำตอบ (undo คืนค่าเดิม)
// tape: { anchor, nx, ny, nw, nh, revealed } — เทปปิดคำตอบ (Phase 2 §8 Q10/Q16) เก็บแยกใน tapes[] ไม่ใช่ stroke
//   nx/ny/nw/nh normalize ด้วย "ความกว้าง" anchor ทั้งหมด เหมือนจุดของ stroke ; แตะเพื่อเปิด/ปิด (revealed) ; undo/redo ไม่ยุ่ง แต่ยางลบ/ขีดฆ่า/ล้างทั้งข้อ ลบได้
// IndexedDB key: scratch_<subjectParam>_<qid> → { qid, subjectParam, strokes, redoStack, tapes, updatedAt }
// localStorage: scratchpad_prefs → { penStyle, pen:{colors,widths,ci,wi}, hl:{...}, eraseHlOnly } (Phase 2 §8 Q15/Q17 — ไม่จำ tool)

(function () {
    var HL_ALPHA = 0.45;
    var PREFS_KEY = 'scratchpad_prefs';
    // Q15: preset สี/ความหนา 3 ช่อง — ปากกากับไฮไลต์แยกชุด ; ci/wi = ช่องที่เลือก ; กดค้างที่จุด/pill แก้ค่าในช่องได้ (popover)
    var DEFAULT_PREFS = {
        penStyle: 'ball',
        pen: { colors: ['#2563eb', '#1e1e1e', '#dc2626'], widths: [1.5, 2.5, 5], ci: 0, wi: 1 },
        hl:  { colors: ['#facc15', '#4ade80', '#f472b6'], widths: [12, 18, 28],  ci: 0, wi: 1 },
        eraseHlOnly: false,          // Q11: ยางลบ + ขีดฆ่า ลบเฉพาะไฮไลต์ (canEraseStroke)
        eraserRadius: 12             // Phase 3 req 6: รัศมียางลบปรับได้ (slider ในแถวยางลบ)
    };
    var WIDTH_RANGE = { pen: [0.5, 12], hl: [6, 40] };   // ช่วง slider ใน popover
    var ERASER_RADIUS_RANGE = [4, 48];
    // Phase 3 req 3: ปุ่มปากกาปุ่มเดียวบนแถวบน — ไอคอนเปลี่ยนตามแบบที่เลือกอยู่ (แบบย้ายไป flyout)
    var PEN_ICONS = { ball: 'fas fa-pen', fountain: 'fas fa-pen-nib', brush: 'fas fa-paint-brush' };
    var LONG_PRESS_MS = 500;
    var ERASER_RADIUS = 12;          // px
    var DECIMATE_SQ = 4;             // R6: ข้ามจุดที่ห่างจากจุดก่อน < 2px
    var PALM_BLOB_PX = 60;           // Phase 3: ปัดทิ้งเมื่อกว้าง "ทั้งสองแกน" เกินนี้ = ฝ่ามือ (เดิม 40 และใช้ AND-เล็ก → iPad รายงานนิ้ว 40–60 เลยวาดไม่ติดเลย)
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
    // Phase 2 §8 Q6–Q8/Q12: วาดค้าง → snap เป็นรูปทรง (เส้นตรง / วงรี / สี่เหลี่ยม) — ไฮไลต์ได้แค่เส้นตรง
    var HOLD_MS = 450;               // ปากกานิ่งนานเท่านี้ (ยังไม่ยก) → ลอง snap
    var HOLD_JITTER_PX = 6;          // ขยับไม่เกินนี้ยังนับว่านิ่ง
    var SNAP_MIN_BBOX = 24;          // px กรอบเส้นต้องกว้างหรือสูงอย่างน้อยเท่านี้ถึงจะเริ่มจับเวลา
    var ELLIPSE_PTS = 40;
    var RECT_EDGE_PTS = 12;          // มุมสี่เหลี่ยมต้องมีจุดถี่ ไม่งั้น streamline ของ perfect-freehand ดึงมุมจนเบี้ยว
    // Phase 2 §8 Q9: ขีดฆ่า (zigzag) ทับเส้นเดิมด้วยปากกา → ลบเส้นนั้นแทนการวาด — ประเมินตอนยกปากกา (ค่าเหล่านี้ยังต้องจูนบน iPad จริง)
    var SCRIBBLE_MIN_PTS = 8;
    var SCRIBBLE_MIN_REVERSALS = 3;  // จำนวนครั้งที่ทิศทางกลับ (แกน x หรือ y)
    var SCRIBBLE_MIN_SWING = 0.3;    // แต่ละช่วงไป-กลับต้องยาว ≥ 30% ของกรอบในแกนนั้น ไม่งั้นนับเป็นมือสั่น
    var SCRIBBLE_DENSITY = 2.5;      // ความยาวเส้นรวม ≥ 2.5 × เส้นทแยงกรอบ — ตัว w / ห่วงเดียวไม่ผ่าน
    var SCRIBBLE_MIN_HITS = 3;       // จุดตัวอย่างของ zigzag ที่โดนเส้นเป้า ≥ เท่านี้ (หรือเส้นเป้าอยู่ในกรอบ zigzag ทั้งเส้น)
    // Phase 2 §8 Q10/Q10b/Q16: เทปปิดคำตอบ — ลากกรอบทับข้อความ ปิดไว้ก่อน แตะแล้วเปิดดู
    var TAPE_MIN_PX = 10;            // ลากสั้นกว่านี้ทั้งสองด้าน = แตะ ไม่ใช่วาดเทปใหม่
    var TAPE_REVEALED_ALPHA = 0.12;  // เปิดแล้วเหลือกรอบจางๆ ให้รู้ว่าตรงนี้มีเทป
    var TAPE_RADIUS = 3;             // มุมมนของแถบเทป (px)
    var TAPE_COLORS = {              // ทึบแสงจริง (ไม่มี alpha) — ต้องบังตัวหนังสือใต้ canvas ได้สนิท
        light: { fill: '#dfe3ea', edge: '#94a3b8' },
        dark:  { fill: '#3a4250', edge: '#64748b' }
    };
    // Phase 3: ท่าทาง (Pencil double-tap / สองนิ้ว) + คีย์ลัด + วงบอกรัศมียางลบ
    var TWO_FINGER_TAP_MS = 300;     // แตะสองนิ้วต้องยกภายในเวลานี้ถึงนับเป็น "แตะ" ไม่ใช่ค้าง
    var TWO_FINGER_GAP_MS = 400;     // สองแตะห่างกันไม่เกินนี้ = double-tap
    var TWO_FINGER_MOVE_PX = 24;     // จุดกึ่งกลางสองนิ้วขยับเกินนี้ = ซูม/เลื่อน ไม่ใช่แตะ
    var ERASER_CURSOR_DASH = [4, 4];
    // Phase 3 req 7: lasso — เลือก ย้าย ย่อขยาย
    var LASSO_HANDLE = 10;           // px ด้านของสี่เหลี่ยมมือจับ (และระยะเผื่อตอนแตะ)
    var LASSO_MIN_PTS = 3;           // ห่วงที่สั้นกว่านี้ไม่ใช่การเลือก
    var LASSO_MIN_SIZE = 8;          // px ย่อกรอบเล็กกว่านี้ไม่ได้ กันหารศูนย์

    var outlineCache = new WeakMap();  // stroke → { w, path } — outline คำนวณแพง ไม่ต้องทำซ้ำทุกเฟรมตอนลากเส้นใหม่

    var wrapper, canvas, ctx, offscreen, offCtx, toolbar;
    var tool = 'pen';
    var prefs = loadPrefs();
    var popTarget = null;            // popover เปิดอยู่ที่ { kind:'color'|'width', idx }
    var swallowPresetClick = false;  // click ที่ตามหลังกดค้าง (touch) ห้ามไปปิด popover ที่เพิ่งเปิด
    var dpr = 1;
    var active = null;               // stroke ที่กำลังลาก
    var activeTape = null;           // เทปที่กำลังลากกรอบ (แยกจาก active — snap/ขีดฆ่า/ฝน badge ไม่ยุ่งกับเทป)
    var activeMeta = null;           // { pointerId, wrapLeft, wrapTop, ax, ay, aw, lastX, lastY, badges }
    var rafPending = false;
    var saveTimer = null;
    var loadSeq = 0;
    var suppressClickUntil = 0;
    var zenOn = false;               // Q4/Q4b: โหมดโฟกัส — ไม่จำใน localStorage (เปิดแอปใหม่ต้องได้หน้าปกติ)
    var zenPrevCollapsed = false;    // สถานะยุบ toolbar ก่อนเข้า Zen — ออกแล้วคืนค่าเดิม
    var eraserCursor = null;         // { x, y } ตำแหน่งวงยางลบบน wrapper — null = ไม่ต้องวาด
    var lastNonEraserTool = null;    // เครื่องมือก่อนสลับไปยางลบ (Pencil double-tap สลับกลับ)
    var twoFinger = null;            // { t, cx, cy, moved } ระหว่างแตะสองนิ้ว
    var lastTwoFingerTapAt = 0;
    var selection = null;            // { strokes, tapes, box } — box เป็น px เทียบ wrapper
    var lassoPath = null;            // [[x,y]...] ห่วงที่กำลังลาก
    var transform = null;            // { mode, handle, startX, startY, box0, items, tapeItems }

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
            if (isFinite(s.eraserRadius) && s.eraserRadius >= ERASER_RADIUS_RANGE[0] && s.eraserRadius <= ERASER_RADIUS_RANGE[1]) p.eraserRadius = Number(s.eraserRadius);
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
    // รัศมียางลบที่ใช้จริง — prefs ยังไม่มีค่า (ก่อน slider ของ Batch B) ก็ถอยไปใช้ค่าคงที่เดิม
    function eraserRadius() {
        var r = prefs.eraserRadius;
        return r > 0 ? r : ERASER_RADIUS;
    }

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

    function isDark() {
        return document.documentElement.getAttribute('data-theme') === 'dark';
    }
    function blendMode() {
        return isDark() ? 'screen' : 'multiply';
    }

    // เทปในพิกัดจริงของ wrapper (px) — normalize ด้วยความกว้าง anchor ทั้ง 4 ค่า เหมือนจุดของ stroke
    function tapeBox(t, rect) {
        return { x: rect.x + t.nx * rect.w, y: rect.y + t.ny * rect.w, w: t.nw * rect.w, h: t.nh * rect.w };
    }
    function tapeRoundRect(c, b) {
        var r = Math.min(TAPE_RADIUS, Math.abs(b.w) / 2, Math.abs(b.h) / 2);
        c.beginPath();
        if (c.roundRect) c.roundRect(b.x, b.y, b.w, b.h, r);
        else c.rect(b.x, b.y, b.w, b.h);
    }
    // Q10b: ยังไม่เปิด = ทึบสนิท (บังตัวหนังสือ) ; เปิดแล้ว = จางๆ + กรอบประ อ่านข้อความข้างใต้ได้
    function drawTape(t, rect, isActive) {
        var b = tapeBox(t, rect);
        if (Math.abs(b.w) < 1 || Math.abs(b.h) < 1) return;
        var col = isDark() ? TAPE_COLORS.dark : TAPE_COLORS.light;
        var open = !!t.revealed;
        ctx.save();
        tapeRoundRect(ctx, b);
        ctx.globalAlpha = open ? TAPE_REVEALED_ALPHA : (isActive ? 0.75 : 1);
        ctx.fillStyle = col.fill;
        ctx.fill();
        ctx.globalAlpha = open || isActive ? 0.6 : 1;
        ctx.strokeStyle = col.edge;
        ctx.lineWidth = 1;
        if (open) ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
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

    // perfect-freehand: จุด normalize → หน่วยของ rect แล้วขอ outline polygon กลับมา (ไม่ใช่ stroke เส้นกลาง)
    // rect ใช้หน่วยอะไรก็ได้ — บนจอส่ง px, ตอนออก PDF ส่ง mm → ได้รูปทรงเดียวกันเป๊ะ ต่างแค่สเกล
    function strokeOutline(stroke, rect, isActive) {
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
        return window.PerfectFreehand.getStroke(input, opts);
    }
    // stroke ที่ commit แล้ว cache Path2D ไว้ (เฉพาะการวาดบนจอ — PDF เรียก strokeOutline ตรงๆ ไม่ผ่าน cache)
    function penOutline(stroke, rect, isActive) {
        var cached = !isActive && outlineCache.get(stroke);
        if (cached && cached.w === rect.w) return cached.path;
        var outline = strokeOutline(stroke, rect, isActive);
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

    // Phase 3 req 8: วงประบอกรัศมียางลบที่ปลายปากกา/เมาส์ — วาดทับสุดท้าย ไม่เก็บลง strokes ไม่เข้า PDF
    function drawEraserCursor() {
        if (!eraserCursor || tool !== 'eraser') return;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.setLineDash(ERASER_CURSOR_DASH);
        ctx.strokeStyle = isDark() ? 'rgba(255,255,255,.85)' : 'rgba(30,30,30,.75)';
        ctx.beginPath();
        ctx.arc(eraserCursor.x, eraserCursor.y, eraserRadius(), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
    function setEraserCursor(x, y) {
        if (tool !== 'eraser') { if (eraserCursor) { eraserCursor = null; requestRender(); } return; }
        eraserCursor = { x: x, y: y };
        requestRender();
    }
    function clearEraserCursor() {
        if (!eraserCursor) return;
        eraserCursor = null;
        requestRender();
    }

    function renderAll() {
        if (!resizeCanvas()) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var st = state();
        if (!st) { drawEraserCursor(); drawLassoUI(); return; }
        var rects = {};
        // เทปวาดก่อนหมึกเสมอ → เทปบังแค่เนื้อหาการ์ด (ใต้ canvas) ลายมือที่เขียนไว้ยังเห็นทับเทป
        st.tapes.forEach(function (t) {
            if (!(t.anchor in rects)) rects[t.anchor] = anchorRect(t.anchor);
            var rect = rects[t.anchor];
            if (rect) drawTape(t, rect);
        });
        if (activeTape && activeMeta) drawTape(activeTape, { x: activeMeta.ax, y: activeMeta.ay, w: activeMeta.aw }, true);
        st.strokes.forEach(function (stroke) {
            if (!(stroke.anchor in rects)) rects[stroke.anchor] = anchorRect(stroke.anchor);
            var rect = rects[stroke.anchor];
            if (rect) drawStroke(stroke, rect);
        });
        if (active && activeMeta) drawStroke(active, { x: activeMeta.ax, y: activeMeta.ay, w: activeMeta.aw }, true);
        drawEraserCursor();
        drawLassoUI();
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
        if (!st.strokes.length && !st.redoStack.length && !st.tapes.length) return deleteCacheDB(key).catch(function () { });
        return window.setCacheDB(key, {
            qid: st.qid, subjectParam: st.subjectParam,
            strokes: st.strokes, tapes: st.tapes, updatedAt: Date.now(),
            redoStack: st.redoStack.filter(function (a) { return a && a.t === 'draw' && a.stroke; })
                                   .map(function (a) { return a.stroke; })
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
        selection = null; lassoPath = null; transform = null;
        window.APP._scratchpadState = { qid: qid, subjectParam: sp, strokes: [], redoStack: [], tapes: [], actions: [] };
        renderAll();
        updateToolbarState();
        window.getCacheDB(scratchKey(sp, qid)).then(function (rec) {
            if (seq !== loadSeq || !rec) return;
            var st = state();
            // ผู้ใช้อาจวาดไปแล้วระหว่างรอโหลด — เอาของเก่าไว้ก่อน ต่อด้วยของใหม่
            st.strokes = (rec.strokes || []).concat(st.strokes);
            st.tapes = (rec.tapes || []).concat(st.tapes);
            if (!st.redoStack.length) st.redoStack = (rec.redoStack || []).map(function (x) { return { t: 'draw', stroke: x }; });
            st.actions = st.strokes.map(function () { return { t: 'draw' }; });
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
        var thr = eraserRadius() + (stroke.width * s) / 2;
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
    // Q11: ตัวกรองเดียวใช้ทั้งยางลบและขีดฆ่า — "ลบเฉพาะไฮไลต์" ปล่อยเส้นปากกาไว้
    function canEraseStroke(stroke) {
        return !prefs.eraseHlOnly || stroke.tool === 'highlighter';
    }
    // เทปไม่ใช่ไฮไลต์ → โหมด "ลบเฉพาะไฮไลต์" กันเทปไว้ด้วย
    function canEraseTape() { return !prefs.eraseHlOnly; }
    function tapeHit(t, rect, px, py) {
        var b = tapeBox(t, rect);
        var x1 = Math.min(b.x, b.x + b.w), x2 = Math.max(b.x, b.x + b.w);
        var y1 = Math.min(b.y, b.y + b.h), y2 = Math.max(b.y, b.y + b.h);
        return px >= x1 && px <= x2 && py >= y1 && py <= y2;
    }
    // เทปที่โดนแตะ — ไล่จากอันหลังสุดก่อน (วาดทีหลัง = อยู่บน)
    function tapeAt(px, py) {
        var st = state();
        if (!st) return null;
        for (var i = st.tapes.length - 1; i >= 0; i--) {
            var rect = anchorRect(st.tapes[i].anchor);
            if (rect && tapeHit(st.tapes[i], rect, px, py)) return st.tapes[i];
        }
        return null;
    }
    // Q10: แตะเทป = เปิด/ปิด — true เมื่อโดนเทป (ผู้เรียกต้องกันไม่ให้ event ไหลไปโดนปุ่มตัวเลือก)
    function toggleTapeAt(clientX, clientY) {
        if (!wrapper || !state()) return false;
        var w = wrapper.getBoundingClientRect();
        var t = tapeAt(clientX - w.left, clientY - w.top);
        if (!t) return false;
        t.revealed = !t.revealed;
        renderAll();
        markDirty();
        return true;
    }
    function eraseAt(px, py) {
        var st = state();
        if (!st) return;
        var rects = {};
        var before = st.strokes.length + st.tapes.length;
        st.strokes = st.strokes.filter(function (stroke) {
            if (!canEraseStroke(stroke)) return true;
            if (!(stroke.anchor in rects)) rects[stroke.anchor] = anchorRect(stroke.anchor);
            var rect = rects[stroke.anchor];
            return !rect || !strokeHit(stroke, rect, px, py);
        });
        if (canEraseTape()) st.tapes = st.tapes.filter(function (t) {
            if (!(t.anchor in rects)) rects[t.anchor] = anchorRect(t.anchor);
            var rect = rects[t.anchor];
            return !rect || !tapeHit(t, rect, px, py);
        });
        if (st.strokes.length + st.tapes.length !== before) { resyncActions(); renderAll(); markDirty(); }
    }

    // ─── Scribble-to-erase (Q9) — ลำดับ: แตะเขต badge ไม่นับ → snap ค้าง (ระหว่างลาก) → ขีดฆ่า (ตอนยก) → หมึกธรรมดา ─
    // นับเฉพาะปากกา: ไฮไลต์ zigzag ทับตัวหนังสือคือการเน้น ไม่ใช่การลบ
    function isScribble(raw) {
        var n = raw.length;
        if (n < SCRIBBLE_MIN_PTS) return false;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, len = 0, i;
        for (i = 0; i < n; i++) {
            var x = raw[i][0], y = raw[i][1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (i) len += Math.hypot(x - raw[i - 1][0], y - raw[i - 1][1]);
        }
        var bw = maxX - minX, bh = maxY - minY;
        if (len < SCRIBBLE_DENSITY * Math.hypot(bw, bh)) return false;
        // นับการกลับทิศต่อแกน — สะสมระยะทางเดียวกัน แล้วนับกลับทิศเมื่อช่วงที่ผ่านมายาวพอ (กันมือสั่น)
        function reversals(axis, extent) {
            var minSwing = extent * SCRIBBLE_MIN_SWING;
            if (minSwing <= 0) return 0;
            var dir = 0, swing = 0, count = 0;
            for (var k = 1; k < n; k++) {
                var d = raw[k][axis] - raw[k - 1][axis];
                if (d === 0) continue;
                var sgn = d > 0 ? 1 : -1;
                if (sgn === dir || dir === 0) { dir = sgn; swing += Math.abs(d); continue; }
                if (swing >= minSwing) count++;
                dir = sgn; swing = Math.abs(d);
            }
            return count;
        }
        return Math.max(reversals(0, bw), reversals(1, bh)) >= SCRIBBLE_MIN_REVERSALS;
    }
    function rawBBox(raw) {
        var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        for (var i = 0; i < raw.length; i++) {
            if (raw[i][0] < b.minX) b.minX = raw[i][0]; if (raw[i][0] > b.maxX) b.maxX = raw[i][0];
            if (raw[i][1] < b.minY) b.minY = raw[i][1]; if (raw[i][1] > b.maxY) b.maxY = raw[i][1];
        }
        return b;
    }
    // คืน array เส้นที่ควรลบ (ว่าง = ไม่ใช่ขีดฆ่า / ไม่มีเส้นให้ลบ → วาดเป็นหมึกตามปกติ)
    function scribbleTargets(raw) {
        var st = state();
        if (!st || !st.strokes.length || !isScribble(raw)) return [];
        var bb = rawBBox(raw), minX = bb.minX, maxX = bb.maxX, minY = bb.minY, maxY = bb.maxY, i;
        var rects = {}, out = [];
        st.strokes.forEach(function (stroke) {
            if (!canEraseStroke(stroke)) return;
            if (!(stroke.anchor in rects)) rects[stroke.anchor] = anchorRect(stroke.anchor);
            var rect = rects[stroke.anchor];
            if (!rect) return;
            var inside = true, hits = 0, k;
            for (k = 0; k < stroke.points.length && inside; k++) {
                var x = rect.x + stroke.points[k].nx * rect.w, y = rect.y + stroke.points[k].ny * rect.w;
                if (x < minX || x > maxX || y < minY || y > maxY) inside = false;
            }
            if (!inside) for (k = 0; k < raw.length && hits < SCRIBBLE_MIN_HITS; k++) {
                if (strokeHit(stroke, rect, raw[k][0], raw[k][1])) hits++;
            }
            if (inside || hits >= SCRIBBLE_MIN_HITS) out.push(stroke);
        });
        return out;
    }
    // เทปโดนขีดฆ่าเมื่อ zigzag อยู่ในกรอบเทป หรือมีจุดตัวอย่างตกในเทป ≥ SCRIBBLE_MIN_HITS
    function scribbleTapeTargets(raw) {
        var st = state();
        if (!st || !st.tapes.length || !canEraseTape() || !isScribble(raw)) return [];
        var bb = rawBBox(raw), rects = {}, out = [];
        st.tapes.forEach(function (t) {
            if (!(t.anchor in rects)) rects[t.anchor] = anchorRect(t.anchor);
            var rect = rects[t.anchor];
            if (!rect) return;
            var b = tapeBox(t, rect);
            var inside = bb.minX >= Math.min(b.x, b.x + b.w) && bb.maxX <= Math.max(b.x, b.x + b.w) &&
                bb.minY >= Math.min(b.y, b.y + b.h) && bb.maxY <= Math.max(b.y, b.y + b.h);
            var hits = 0;
            if (!inside) for (var k = 0; k < raw.length && hits < SCRIBBLE_MIN_HITS; k++) {
                if (tapeHit(t, rect, raw[k][0], raw[k][1])) hits++;
            }
            if (inside || hits >= SCRIBBLE_MIN_HITS) out.push(t);
        });
        return out;
    }
    function scribbleErase(targets, tapeTargets) {
        var st = state();
        st.strokes = st.strokes.filter(function (s) { return targets.indexOf(s) === -1; });
        if (tapeTargets.length) st.tapes = st.tapes.filter(function (t) { return tapeTargets.indexOf(t) === -1; });
        for (var i = targets.length - 1; i >= 0; i--) restoreSelection(targets[i], 'previousSelectedAnswer');
        resyncActions();
        markDirty();
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
    // Phase 3 req 9: ปัดฝ่ามือต้อง "ใหญ่ทั้งสองแกน" ถึงจะทิ้ง — เกณฑ์เดิม (เล็กทั้งสองแกน ถึงจะวาด) ตัดนิ้วจริงบน iPad
    // ทิ้งหมด เพราะ Safari รายงาน PointerEvent.width/height ของนิ้วราว 40–60px วาดด้วยนิ้วเลยไม่ทำงานเลย
    function wantsDraw(e) {
        if (e.pointerType === 'pen') return true;
        if (twoFinger) return false;             // อยู่ระหว่างท่าทางสองนิ้ว ไม่ใช่การวาด
        if (e.pointerType === 'touch' && window.APP._fingerDrawMode) return !(e.width >= PALM_BLOB_PX && e.height >= PALM_BLOB_PX);
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
            setEraserCursor(px, py);
            eraseAt(px, py);
            return;
        }

        var anchor = anchorFromTarget(e.target);
        var rect = anchorRect(anchor);
        if (!rect) { anchor = 'card'; rect = anchorRect('card'); }

        // Q10: เทป — ลากเป็นกรอบ (ลากสั้น = แตะเปิด/ปิดเทปเดิม ตัดสินตอนยกปากกา)
        if (tool === 'tape') {
            activeTape = { anchor: anchor, nx: (px - rect.x) / rect.w, ny: (py - rect.y) / rect.w, nw: 0, nh: 0, revealed: false };
            activeMeta = {
                pointerId: e.pointerId, wrapLeft: w.left, wrapTop: w.top,
                ax: rect.x, ay: rect.y, aw: rect.w, startX: px, startY: py, taping: true
            };
            beginCapture(e);
            requestRender();
            return;
        }

        // Phase 3 req 7: มือจับ/ในกรอบ = แปลงรูป ; ที่ว่าง = เริ่มลากห่วงเลือกใหม่
        if (tool === 'lasso') {
            activeMeta = { pointerId: e.pointerId, wrapLeft: w.left, wrapTop: w.top, lasso: true };
            var h = handleAt(px, py);
            if (h) beginTransform('scale', h, px, py);
            else if (insideBox(px, py)) beginTransform('move', null, px, py);
            else { selection = null; lassoPath = [[px, py]]; }
            beginCapture(e);
            requestRender();
            return;
        }

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
            pressure: e.pointerType === 'pen',
            raw: [[px, py]], minX: px, maxX: px, minY: py, maxY: py,
            holdX: px, holdY: py, holdTimer: null
        };
        active.points.push(makePoint(px, py, e));
        beginCapture(e);
        requestRender();
    }

    // ─── Draw-and-hold shape snap (Q6–Q8, Q12) ───────────────
    // ไม่ snap บนปุ่มตัวเลือกหรือเส้นที่แตะเข้าเขต badge — กันชนกับการฝนเลือกคำตอบ (Phase 1b)
    function touchedBadge() {
        var badges = activeMeta.badges;
        for (var i = 0; i < badges.length; i++) if (badges[i].len > 0) return true;
        return false;
    }
    function canSnap() {
        if (!active || active._snapped || active.anchor.indexOf('choice:') === 0) return false;
        return !touchedBadge();
    }
    function trackHold(px, py) {
        var m = activeMeta;
        m.raw.push([px, py]);
        if (px < m.minX) m.minX = px; if (px > m.maxX) m.maxX = px;
        if (py < m.minY) m.minY = py; if (py > m.maxY) m.maxY = py;
        if (Math.hypot(px - m.holdX, py - m.holdY) <= HOLD_JITTER_PX) return;
        m.holdX = px; m.holdY = py;
        clearHold();
        if (!canSnap()) return;
        if (m.maxX - m.minX < SNAP_MIN_BBOX && m.maxY - m.minY < SNAP_MIN_BBOX) return;
        m.holdTimer = setTimeout(trySnap, HOLD_MS);
    }
    function clearHold() {
        if (activeMeta && activeMeta.holdTimer) { clearTimeout(activeMeta.holdTimer); activeMeta.holdTimer = null; }
    }
    function trySnap() {
        if (!activeMeta) return;
        activeMeta.holdTimer = null;
        if (!canSnap()) return;
        var shape = classifyShape(activeMeta.raw, active.tool === 'highlighter');
        if (!shape) return;
        var pts = synthesizeShape(shape, activeMeta);
        active.points = pts.map(function (p) {
            var pt = { nx: (p[0] - activeMeta.ax) / activeMeta.aw, ny: (p[1] - activeMeta.ay) / activeMeta.aw };
            if (activeMeta.pressure) pt.p = 0.5;
            return pt;
        });
        active.shapeType = shape;
        active._snapped = true;
        requestRender();
    }
    // line: ทุกจุดห่างจากคอร์ดต้น→ปลายไม่เกิน max(6px, 8% ของคอร์ด) ; closed: ต้น-ปลายใกล้กัน ;
    // rect vs ellipse: พื้นที่ (shoelace) / พื้นที่กรอบ — วงกลมวาดมือ ≈ 0.78, สี่เหลี่ยม ≈ 0.9+
    function classifyShape(raw, lineOnly) {
        var n = raw.length;
        if (n < 3) return null;
        var x0 = raw[0][0], y0 = raw[0][1], xn = raw[n - 1][0], yn = raw[n - 1][1];
        var chord = Math.hypot(xn - x0, yn - y0);
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxDev = 0, area = 0;
        for (var i = 0; i < n; i++) {
            var x = raw[i][0], y = raw[i][1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            var dev = chord > 0 ? Math.abs((xn - x0) * (y0 - y) - (x0 - x) * (yn - y0)) / chord : Math.hypot(x - x0, y - y0);
            if (dev > maxDev) maxDev = dev;
            var j = (i + 1) % n;
            area += x * raw[j][1] - raw[j][0] * y;
        }
        if (maxDev <= Math.max(6, chord * 0.08)) return 'line';
        if (lineOnly) return null;
        var bw = maxX - minX, bh = maxY - minY;
        if (chord > Math.max(bw, bh) * 0.2 + 10) return null;
        return Math.abs(area) / 2 / (bw * bh) >= 0.86 ? 'rect' : 'ellipse';
    }
    function synthesizeShape(shape, m) {
        var raw = m.raw;
        if (shape === 'line') return [raw[0], raw[raw.length - 1]];
        var x1 = m.minX, y1 = m.minY, x2 = m.maxX, y2 = m.maxY;
        var out = [], i, t;
        if (shape === 'rect') {
            var c = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
            for (var e = 0; e < 4; e++) for (i = 0; i < RECT_EDGE_PTS; i++) {
                t = i / RECT_EDGE_PTS;
                out.push([c[e][0] + (c[e + 1][0] - c[e][0]) * t, c[e][1] + (c[e + 1][1] - c[e][1]) * t]);
            }
            out.push([x1, y1]);
            return out;
        }
        var cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = (x2 - x1) / 2, ry = (y2 - y1) / 2;
        for (i = 0; i <= ELLIPSE_PTS; i++) {
            t = (i % ELLIPSE_PTS) / ELLIPSE_PTS * Math.PI * 2;
            out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
        }
        return out;
    }

    // Q2: เก็บ p เฉพาะ Pencil — นิ้ว/เมาส์ไม่มี p ให้ perfect-freehand จำลองจากความเร็ว (simulatePressure)
    function makePoint(px, py, e) {
        var pt = { nx: (px - activeMeta.ax) / activeMeta.aw, ny: (py - activeMeta.ay) / activeMeta.aw };
        if (activeMeta.pressure) pt.p = e.pressure;
        return pt;
    }

    // กรอบเทประหว่างลาก — เก็บมุมซ้ายบน + กว้าง/สูงเป็นบวกเสมอ (ลากย้อนขึ้นซ้ายก็ได้)
    function sizeTape(px, py) {
        var m = activeMeta;
        activeTape.nx = (Math.min(m.startX, px) - m.ax) / m.aw;
        activeTape.ny = (Math.min(m.startY, py) - m.ay) / m.aw;
        activeTape.nw = Math.abs(px - m.startX) / m.aw;
        activeTape.nh = Math.abs(py - m.startY) / m.aw;
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
        if (activeMeta.erasing) { setEraserCursor(px, py); eraseAt(px, py); return; }
        if (activeMeta.taping) { sizeTape(px, py); requestRender(); return; }
        if (activeMeta.lasso) {
            if (transform) updateTransform(px, py);
            else if (lassoPath) lassoPath.push([px, py]);
            requestRender();
            return;
        }
        if (active._snapped) return;   // Q7: snap แล้วล็อกจนยกปากกา
        var dx = px - activeMeta.lastX, dy = py - activeMeta.lastY;
        if (dx * dx + dy * dy < DECIMATE_SQ) return;
        accumulateShade(activeMeta.lastX, activeMeta.lastY, px, py);
        activeMeta.lastX = px; activeMeta.lastY = py;
        active.points.push(makePoint(px, py, e));
        trackHold(px, py);
        requestRender();
    }

    function onPointerEnd(e) {
        if (!activeMeta || e.pointerId !== activeMeta.pointerId) return;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { }
        canvas.style.pointerEvents = 'none';
        wrapper.classList.remove('scratchpad-drawing');
        suppressClickUntil = Date.now() + 400;
        clearHold();

        // เทป: ลากได้ขนาด = เทปใหม่ ; ลากไม่ถึงเกณฑ์ = แตะ → เปิด/ปิดเทปที่อยู่ตรงนั้น
        if (activeTape && e.type !== 'pointercancel') {
            var tx = e.clientX - activeMeta.wrapLeft, ty = e.clientY - activeMeta.wrapTop;
            sizeTape(tx, ty);
            if (activeTape.nw * activeMeta.aw >= TAPE_MIN_PX && activeTape.nh * activeMeta.aw >= TAPE_MIN_PX) {
                state().tapes.push(activeTape);
                markDirty();
            } else {
                var hit = tapeAt(tx, ty);
                if (hit) { hit.revealed = !hit.revealed; markDirty(); }
            }
        }

        if (activeMeta.lasso) {
            if (transform) {
                if (e.type === 'pointercancel') { applyTransform(transform.box0, transform.box0); transform = null; }
                else commitTransform();
            } else if (lassoPath) {
                if (e.type !== 'pointercancel') selection = buildSelection(lassoPath);
                lassoPath = null;
            }
        }

        if (active) {
            if (e.type !== 'pointercancel') {
                // R6: จุดสุดท้ายเก็บเสมอ ไม่ผ่าน decimation (ยกเว้น stroke ที่ snap แล้ว)
                if (!active._snapped) {
                    var px = e.clientX - activeMeta.wrapLeft, py = e.clientY - activeMeta.wrapTop;
                    accumulateShade(activeMeta.lastX, activeMeta.lastY, px, py);
                    active.points.push(makePoint(px, py, e));
                    activeMeta.raw.push([px, py]);
                }
                // Q9: ขีดฆ่าทับเส้นเดิม → ลบเส้นนั้น ทิ้ง zigzag ไม่บันทึก (ไม่ทำเมื่อ snap แล้ว หรือเส้นแตะเขต badge)
                var canScribble = active.tool === 'pen' && !active._snapped && !touchedBadge();
                var targets = canScribble ? scribbleTargets(activeMeta.raw) : [];
                var tapeTargets = canScribble ? scribbleTapeTargets(activeMeta.raw) : [];
                if (targets.length || tapeTargets.length) {
                    scribbleErase(targets, tapeTargets);
                } else {
                    var caused = commitShade();
                    if (caused) active.causedSelection = caused;
                    delete active._snapped;
                    var st = state();
                    st.strokes.push(active);
                    st.actions.push({ t: 'draw' });
                    st.redoStack = [];
                    markDirty();
                }
            }
            active = null;
        }
        clearShadingClass();
        activeTape = null;
        activeMeta = null;
        renderAll();
    }

    // ทิ้งเส้น/เทปที่กำลังลากโดยไม่บันทึก — ใช้ตอนนิ้วที่สองแตะลงมา (เป็นท่าทาง ไม่ใช่การวาด)
    function abortActive() {
        if (!activeMeta) return;
        if (transform) { applyTransform(transform.box0, transform.box0); transform = null; }
        lassoPath = null;
        clearHold();
        try { canvas.releasePointerCapture(activeMeta.pointerId); } catch (err) { }
        canvas.style.pointerEvents = 'none';
        wrapper.classList.remove('scratchpad-drawing');
        clearShadingClass();
        active = null; activeTape = null; activeMeta = null;
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
        if (e.touches.length > 1) return;        // สองนิ้วขึ้นไป = ท่าทาง/ซูม ปล่อยให้ onTwoFingerTouch จัดการ
        var stylus = t.touchType === 'stylus';
        if (!stylus && !window.APP._fingerDrawMode) return;
        if (e.target.closest('textarea, input, [contenteditable]')) return;
        if (wrapper.classList.contains('scratchpad-disabled')) return;
        // Phase 3 req 9: โหมดนิ้ว กันเฉพาะตอนลาก (touchmove) — กัน touchstart จะฆ่า click สังเคราะห์
        // ทำให้แตะเลือกตัวเลือก/เปิดเทปไม่ได้ ; หน้าไม่เลื่อนอยู่แล้วเพราะ .scratchpad-finger ตั้ง touch-action:none
        if (!stylus && e.type === 'touchstart') return;
        e.preventDefault();
    }

    // ─── ท่าทางสองนิ้ว (Phase 3 req 2a): แตะสองนิ้วสองครั้ง = undo แบบ GoodNotes/Procreate ─
    // อ่านจาก touch event เพราะ pointer event แยก "สองนิ้วพร้อมกัน" ไม่ได้ในตัวเอง
    function touchCentroid(list) {
        var x = 0, y = 0;
        for (var i = 0; i < list.length; i++) { x += list[i].clientX; y += list[i].clientY; }
        return { x: x / list.length, y: y / list.length };
    }
    function onTwoFingerTouch(e) {
        if (wrapper.classList.contains('scratchpad-disabled')) return;
        if (e.type === 'touchstart') {
            if (e.touches.length !== 2) { if (e.touches.length > 2) twoFinger = null; return; }
            abortActive();                       // นิ้วแรกอาจเริ่มลากไปแล้ว — ทิ้ง ไม่บันทึกเป็นเส้น
            var c = touchCentroid(e.touches);
            twoFinger = { t: Date.now(), cx: c.x, cy: c.y, moved: false };
            return;
        }
        if (!twoFinger) return;
        if (e.type === 'touchmove') {
            if (e.touches.length !== 2) { twoFinger.moved = true; return; }
            var m = touchCentroid(e.touches);
            if (Math.hypot(m.x - twoFinger.cx, m.y - twoFinger.cy) > TWO_FINGER_MOVE_PX) twoFinger.moved = true;
            return;
        }
        // touchend / touchcancel — ตัดสินตอนนิ้วแรกยก แล้วเคลียร์ (นิ้วที่สองยกทีหลังจะ return ที่ !twoFinger)
        var g = twoFinger;
        twoFinger = null;
        suppressClickUntil = Date.now() + 400;   // ยกสองนิ้วแล้วอย่าให้ click หลุดไปโดนตัวเลือก
        if (e.type === 'touchcancel' || g.moved || Date.now() - g.t > TWO_FINGER_TAP_MS) { lastTwoFingerTapAt = 0; return; }
        var now = Date.now();
        if (now - lastTwoFingerTapAt <= TWO_FINGER_GAP_MS) { lastTwoFingerTapAt = 0; undo(); }
        else lastTwoFingerTapAt = now;
    }

    // ─── Lasso / Transform (Phase 3 req 7) ───────────────────
    // เลือกด้วยการลากห่วงล้อม (ต้องล้อมทั้งเส้น/ทั้งแถบเทป) → กรอบ + มือจับ 4 มุม ; ลากในกรอบ = ย้าย ลากมุม = ย่อขยาย
    // คณิตศาสตร์ทำในหน่วย px บนจอทั้งหมด แล้วเขียนกลับเป็นพิกัดปกติ "ด้วย anchor เดิมของแต่ละเส้น"
    // ห้ามย้าย anchor — ย้ายแล้วเนื้อหาจัดบรรทัดใหม่ทีไร ลายเส้นจะกระโดดตามของใหม่
    function pointInPoly(x, y, poly) {
        var inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    function clearSelection() {
        if (!selection) return;
        selection = null;
        requestRender();
    }
    function selectionBox(strokes, tapes) {
        var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }, any = false;
        strokes.forEach(function (s) {
            var rect = anchorRect(s.anchor);
            if (!rect) return;
            s.points.forEach(function (p) {
                var x = rect.x + p.nx * rect.w, y = rect.y + p.ny * rect.w;
                if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
                if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
                any = true;
            });
        });
        tapes.forEach(function (t) {
            var rect = anchorRect(t.anchor);
            if (!rect) return;
            var bx = tapeBox(t, rect);
            var x1 = Math.min(bx.x, bx.x + bx.w), x2 = Math.max(bx.x, bx.x + bx.w);
            var y1 = Math.min(bx.y, bx.y + bx.h), y2 = Math.max(bx.y, bx.y + bx.h);
            if (x1 < b.minX) b.minX = x1; if (x2 > b.maxX) b.maxX = x2;
            if (y1 < b.minY) b.minY = y1; if (y2 > b.maxY) b.maxY = y2;
            any = true;
        });
        if (!any) return null;
        return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
    }
    function buildSelection(poly) {
        var st = state();
        if (!st || poly.length < LASSO_MIN_PTS) return null;
        var strokes = st.strokes.filter(function (s) {
            var rect = anchorRect(s.anchor);
            if (!rect || !s.points.length) return false;
            return s.points.every(function (p) {
                return pointInPoly(rect.x + p.nx * rect.w, rect.y + p.ny * rect.w, poly);
            });
        });
        var tapes = st.tapes.filter(function (t) {
            var rect = anchorRect(t.anchor);
            if (!rect) return false;
            var b = tapeBox(t, rect);
            return [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]
                .every(function (c) { return pointInPoly(c[0], c[1], poly); });
        });
        if (!strokes.length && !tapes.length) return null;
        var box = selectionBox(strokes, tapes);
        return box ? { strokes: strokes, tapes: tapes, box: box } : null;
    }
    // มือจับ 4 มุม — คืนชื่อมุมที่โดน หรือ null
    function handleAt(px, py) {
        if (!selection) return null;
        var b = selection.box, names = ['nw', 'ne', 'sw', 'se'];
        var pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
        for (var i = 0; i < 4; i++) {
            if (Math.abs(px - pts[i][0]) <= LASSO_HANDLE && Math.abs(py - pts[i][1]) <= LASSO_HANDLE) return names[i];
        }
        return null;
    }
    function insideBox(px, py) {
        if (!selection) return false;
        var b = selection.box;
        return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
    }
    function beginTransform(mode, handle, px, py) {
        transform = {
            mode: mode, handle: handle, startX: px, startY: py,
            box0: { x: selection.box.x, y: selection.box.y, w: selection.box.w, h: selection.box.h },
            items: selection.strokes.map(function (s) { return { stroke: s, prev: geomOf(s) }; }),
            tapeItems: selection.tapes.map(function (t) { return { tape: t, prev: tapeGeom(t) }; })
        };
    }
    // คำนวณกรอบใหม่จากการลาก แล้วยิงพิกัดใหม่ทับของจริงทุกเฟรม (พรีวิวสด) โดยคิดจาก snapshot เสมอ
    function updateTransform(px, py) {
        transform.dirty = true;
        var b0 = transform.box0, dx = px - transform.startX, dy = py - transform.startY;
        var b1;
        if (transform.mode === 'move') {
            b1 = { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h };
        } else {
            var x1 = b0.x, y1 = b0.y, x2 = b0.x + b0.w, y2 = b0.y + b0.h;
            if (transform.handle.charAt(0) === 'n') y1 += dy; else y2 += dy;
            if (transform.handle.charAt(1) === 'w') x1 += dx; else x2 += dx;
            b1 = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
            if (b1.w < LASSO_MIN_SIZE) { b1.w = LASSO_MIN_SIZE; b1.x = b0.x; }
            if (b1.h < LASSO_MIN_SIZE) { b1.h = LASSO_MIN_SIZE; b1.y = b0.y; }
        }
        applyTransform(b0, b1);
    }
    function applyTransform(b0, b1) {
        var sx = b0.w ? b1.w / b0.w : 1, sy = b0.h ? b1.h / b0.h : 1;
        var scale = Math.sqrt(Math.abs(sx * sy)) || 1;
        transform.items.forEach(function (it) {
            var rect = anchorRect(it.stroke.anchor);
            if (!rect) return;
            it.stroke.points = it.prev.points.map(function (p) {
                var x = b1.x + (rect.x + p.nx * rect.w - b0.x) * sx;
                var y = b1.y + (rect.y + p.ny * rect.w - b0.y) * sy;
                var o = { nx: (x - rect.x) / rect.w, ny: (y - rect.y) / rect.w };
                if ('p' in p) o.p = p.p;
                return o;
            });
            it.stroke.width = it.prev.width * scale;
            outlineCache.delete(it.stroke);   // WeakMap คีย์เป็นตัว stroke — ไม่ล้าง จะวาด outline เก่าค้าง
        });
        transform.tapeItems.forEach(function (it) {
            var rect = anchorRect(it.tape.anchor);
            if (!rect) return;
            var x = b1.x + (rect.x + it.prev.nx * rect.w - b0.x) * sx;
            var y = b1.y + (rect.y + it.prev.ny * rect.w - b0.y) * sy;
            it.tape.nx = (x - rect.x) / rect.w;
            it.tape.ny = (y - rect.y) / rect.w;
            it.tape.nw = it.prev.nw * sx;
            it.tape.nh = it.prev.nh * sy;
        });
        selection.box = b1;
    }
    function commitTransform() {
        var st = state();
        if (transform.dirty && st) {
            st.actions.push({ t: 'transform', items: transform.items, tapeItems: transform.tapeItems });
            st.redoStack = [];
            markDirty();
        }
        transform = null;
    }
    function drawLassoUI() {
        if (tool !== 'lasso') return;
        ctx.save();
        if (lassoPath && lassoPath.length > 1) {
            ctx.setLineDash([5, 4]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = isDark() ? 'rgba(255,255,255,.9)' : 'rgba(37,99,235,.9)';
            ctx.beginPath();
            ctx.moveTo(lassoPath[0][0], lassoPath[0][1]);
            for (var i = 1; i < lassoPath.length; i++) ctx.lineTo(lassoPath[i][0], lassoPath[i][1]);
            ctx.closePath();
            ctx.stroke();
        }
        if (selection) {
            var b = selection.box;
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = isDark() ? 'rgba(147,197,253,.95)' : 'rgba(37,99,235,.95)';
            ctx.strokeRect(b.x, b.y, b.w, b.h);
            ctx.setLineDash([]);
            ctx.fillStyle = isDark() ? '#0f172a' : '#ffffff';
            var pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
            pts.forEach(function (p) {
                ctx.beginPath();
                ctx.rect(p[0] - LASSO_HANDLE / 2, p[1] - LASSO_HANDLE / 2, LASSO_HANDLE, LASSO_HANDLE);
                ctx.fill();
                ctx.stroke();
            });
        }
        ctx.restore();
    }

    // ─── Undo / Redo / Clear ─────────────────────────────────
    // Q4: stroke ที่ทำให้เลือกคำตอบ undo แล้วคืนคำตอบเดิม / redo เลือกกลับ ; clearAll ลบเฉพาะลายเส้น ไม่แตะคำตอบ
    // Phase 3 req 7: undo เป็นรายการ "การกระทำ" แล้ว ไม่ใช่แค่ pop เส้นท้ายสุด — การย้าย/ย่อขยายด้วย
    // lasso แก้เส้นเดิมในที่ ไม่ได้เพิ่มเส้นใหม่ จึงต้องเก็บพิกัดก่อนหน้าไว้คืน
    // actions เก็บในหน่วยความจำเท่านั้น (รูปแบบใน IndexedDB ไม่เปลี่ยน) — โหลดใหม่จะสร้างเป็น draw ล้วน
    // เท่ากับพฤติกรรมเดิมเป๊ะ ; transform ที่ทำก่อนเปลี่ยนข้อ/รีเฟรช จึง undo ไม่ได้ (เหมือนเทปที่ undo ไม่ได้)
    function geomOf(stroke) { return { points: stroke.points, width: stroke.width }; }
    function setGeom(stroke, g) { stroke.points = g.points; stroke.width = g.width; outlineCache.delete(stroke); }
    function tapeGeom(t) { return { nx: t.nx, ny: t.ny, nw: t.nw, nh: t.nh }; }
    function setTapeGeom(t, g) { t.nx = g.nx; t.ny = g.ny; t.nw = g.nw; t.nh = g.nh; }
    // ยางลบ/ขีดฆ่าทำให้ index ของ draw marker ไม่ตรงกับ strokes อีก (พฤติกรรมเดิมก็ undo ข้ามอยู่แล้ว)
    // → รีเซ็ตประวัติให้ตรงกับสภาพจริง ดีกว่าปล่อยให้ undo คืนของผิดตัว
    function resyncActions() {
        var st = state();
        if (!st) return;
        st.actions = st.strokes.map(function () { return { t: 'draw' }; });
        st.redoStack = [];
    }
    function undo() {
        var st = state();
        if (!st || !st.actions || !st.actions.length) return;
        var a = st.actions.pop();
        if (a.t === 'transform') {
            a.items.forEach(function (it) { var g = geomOf(it.stroke); setGeom(it.stroke, it.prev); it.next = g; });
            a.tapeItems.forEach(function (it) { var g = tapeGeom(it.tape); setTapeGeom(it.tape, it.prev); it.next = g; });
            clearSelection();
        } else {
            if (!st.strokes.length) return;
            var s = st.strokes.pop();
            a.stroke = s;
            restoreSelection(s, 'previousSelectedAnswer');
        }
        st.redoStack.push(a);
        renderAll(); markDirty();
    }
    function redo() {
        var st = state();
        if (!st || !st.redoStack.length) return;
        var a = st.redoStack.pop();
        if (a.t === 'transform') {
            a.items.forEach(function (it) { setGeom(it.stroke, it.next); });
            a.tapeItems.forEach(function (it) { setTapeGeom(it.tape, it.next); });
            clearSelection();
        } else {
            st.strokes.push(a.stroke);
            restoreSelection(a.stroke, 'newSelectedAnswer');
        }
        st.actions.push(a);
        renderAll(); markDirty();
    }
    function clearAll() {
        var st = state();
        if (!st || (!st.strokes.length && !st.redoStack.length && !st.tapes.length)) return;
        Swal.fire({
            title: 'ล้างลายเส้นของข้อนี้?',
            text: 'ลบลายเส้นและเทปที่ทำไว้ในข้อนี้ ข้ออื่นไม่กระทบ',
            icon: 'warning', showCancelButton: true,
            confirmButtonText: 'ล้าง', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#d33'
        }).then(function (r) {
            if (!r.isConfirmed) return;
            st.strokes = []; st.redoStack = []; st.tapes = []; st.actions = []; clearSelection();
            renderAll(); markDirty();
        });
    }

    // ─── Toolbar ─────────────────────────────────────────────
    // Q13: ปุ่ม Ball/Fountain/Brush = tool 'pen' + data-sp-style — คลิกเดียวตั้งทั้งคู่ ; แบบปากกาจำใน prefs
    function setTool(t, style) {
        tool = t;
        if (t !== 'eraser') eraserCursor = null;   // เปลี่ยนไปเครื่องมืออื่น วงยางลบต้องหายทันที
        if (t !== 'lasso') { selection = null; lassoPath = null; }
        if (t === 'pen' && PEN_STYLES[style]) { prefs.penStyle = style; savePrefs(); }
        // ปุ่มที่ไม่ระบุ data-sp-style (ปุ่มปากกาหลักบนแถวบน) = active เมื่อเครื่องมือตรง ไม่สนแบบ
        toolbar.querySelectorAll('.sp-tool, .sp-style-opt').forEach(function (b) {
            var on = b.dataset.spTool === t && (!b.dataset.spStyle || b.dataset.spStyle === prefs.penStyle);
            b.classList.toggle('active', on);
        });
        var penBtn = toolbar.querySelector('[data-sp-flyout="pen"] i');
        if (penBtn) penBtn.className = PEN_ICONS[prefs.penStyle] || PEN_ICONS.ball;
        hidePopover();
        hideFlyout();
        renderCtxRow();
        requestRender();       // วงยางลบเพิ่งถูกล้าง/เพิ่งใช้ได้ — ต้องวาด canvas ใหม่
    }
    // แถว 2 ตามเครื่องมือ: ปากกา/ไฮไลต์ = จุดสี + pill ความหนา ; ยางลบ = checkbox ; อื่นๆ ซ่อนทั้งแถว
    function renderCtxRow() {
        var hasPresets = tool === 'pen' || tool === 'highlighter';
        toolbar.querySelector('.sp-row-ctx').hidden = !hasPresets && tool !== 'eraser';
        toolbar.querySelector('.sp-presets').hidden = !hasPresets;
        toolbar.querySelector('.sp-eraser-opt').hidden = tool !== 'eraser';
        toolbar.querySelector('.sp-eraser-size').hidden = tool !== 'eraser';
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
        var er = document.getElementById('sp-eraser-radius');
        if (er) {
            er.min = ERASER_RADIUS_RANGE[0]; er.max = ERASER_RADIUS_RANGE[1];
            er.value = eraserRadius();
            document.getElementById('sp-eraser-radius-val').textContent = eraserRadius() + 'px';
        }
    }
    // Phase 3 req 3: flyout เลือกแบบปากกา — คลาสแยกจาก .sp-popover เพราะ hidePopover ใช้ querySelector ตัวแรก
    function showFlyout() {
        var f = toolbar.querySelector('.sp-flyout');
        if (f) f.hidden = false;
    }
    function hideFlyout() {
        var f = toolbar.querySelector('.sp-flyout');
        if (f) f.hidden = true;
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
    // กดค้างได้ทั้งช่อง preset (เปิด popover) และปุ่มปากกาหลัก (เปิด flyout เลือกแบบ)
    function longPressTarget(el) {
        var p = presetTarget(el);
        if (p) return { kind: 'preset', preset: p };
        return el.closest('[data-sp-flyout]') ? { kind: 'flyout' } : null;
    }
    function openLongPress(t) {
        swallowPresetClick = true;
        if (t.kind === 'flyout') showFlyout();
        else showPopover(t.preset.kind, t.preset.idx);
    }
    // กดค้าง 500ms ที่จุด/pill → popover ; ขยับเกิน 8px (เลื่อนแถวบนมือถือ) หรือปล่อยก่อน = ยกเลิก
    function initLongPress() {
        var timer = null, sx = 0, sy = 0;
        function cancel() { if (timer) clearTimeout(timer); timer = null; }
        toolbar.addEventListener('pointerdown', function (e) {
            var t = longPressTarget(e.target);
            if (!t) return;
            cancel();
            sx = e.clientX; sy = e.clientY;
            timer = setTimeout(function () { timer = null; openLongPress(t); }, LONG_PRESS_MS);
        });
        toolbar.addEventListener('pointermove', function (e) {
            if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
        });
        toolbar.addEventListener('pointerup', cancel);
        toolbar.addEventListener('pointercancel', cancel);
        toolbar.addEventListener('contextmenu', function (e) {
            var t = longPressTarget(e.target);
            if (!t) return;
            e.preventDefault();
            cancel();
            if (t.kind === 'flyout') showFlyout();
            else showPopover(t.preset.kind, t.preset.idx);
        });
    }
    function updateToolbarState() {
        var st = state();
        var u = toolbar.querySelector('[data-sp-act="undo"]');
        var r = toolbar.querySelector('[data-sp-act="redo"]');
        var c = toolbar.querySelector('[data-sp-act="clear"]');
        if (u) u.disabled = !st || !st.actions || !st.actions.length;
        if (r) r.disabled = !st || !st.redoStack.length;
        if (c) c.disabled = !st || (!st.strokes.length && !st.redoStack.length && !st.tapes.length);
    }
    // ─── Phase 3 req 1: Apple Pencil แตะสองครั้งที่ก้าน ─────
    // Safari/iPadOS ยิง webkitpencilaction ที่ window (ไม่มีในเบราว์เซอร์อื่น — ทดสอบจริงได้บน iPad เท่านั้น)
    function togglePenEraser() {
        if (tool === 'eraser') setTool(lastNonEraserTool || 'pen', prefs.penStyle);
        else { lastNonEraserTool = tool; setTool('eraser'); }
    }
    function onPencilAction(e) {
        if (e && e.cancelable) e.preventDefault();
        togglePenEraser();
    }

    // ─── Phase 3 req 2b: คีย์ลัด undo/redo ทั้งหน้า ─────────
    // ไม่ทำงานเมื่อเคอร์เซอร์อยู่ในช่องพิมพ์ (MEQ textarea / ช่องค้นหา / chatbot) หรือมี modal เปิดอยู่
    function isTypingTarget(el) {
        return !!(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]'));
    }
    function onKeyDown(e) {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (isTypingTarget(document.activeElement)) return;
        if (!wrapper || wrapper.classList.contains('scratchpad-disabled')) return;
        if (!state()) return;
        var k = (e.key || '').toLowerCase();
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
        else if (k === 'y' && !e.shiftKey) { e.preventDefault(); redo(); }
    }

    function setFingerMode(on) {
        window.APP._fingerDrawMode = on;
        wrapper.classList.toggle('scratchpad-finger', on);
        var b = toolbar.querySelector('[data-sp-act="finger"]');
        if (b) b.classList.toggle('active', on);
    }

    // ความกว้างที่การ์ดใช้ "ตอนไม่ Zen" — ถอด class ออกวัดแล้วใส่คืน (getBoundingClientRect บังคับ layout ทันที)
    // ต้องเท่าเดิมเป๊ะ ไม่งั้นข้อความ reflow ใต้ลายเส้นที่อยู่กับที่ (ลายเส้น normalize ด้วยความกว้าง anchor)
    // เรียก "หลัง" ใส่ class แล้วเท่านั้น — padding คิดจาก clientWidth ของ overlay (หักแถบเลื่อนของตัวเองแล้ว)
    // ใช้ % ไม่ได้ เพราะ % คิดจากความกว้างเต็มจอ ยังไม่หัก scrollbar → การ์ดแคบลงเท่าความกว้างแถบเลื่อน
    function syncZenWidth() {
        var qc = document.getElementById('quiz-container');
        if (!qc) return;
        document.body.classList.remove('sp-zen');
        var w = wrapper.getBoundingClientRect().width;
        document.body.classList.add('sp-zen');
        if (w <= 0) return;
        qc.style.setProperty('--sp-zen-w', w + 'px');
        qc.style.setProperty('--sp-zen-pad', Math.max(0, (qc.clientWidth - w) / 2) + 'px');
    }

    // Q4/Q4b: Zen = โปรโมต #quiz-container เป็น overlay เต็มจอด้วย CSS ล้วน (ดู css/scratchpad.css)
    // subtree ของ #quiz-card-wrapper ไม่ถูกแตะ — CSS คุมความกว้างให้เท่าเดิมเป๊ะ ข้อความจึงไม่ reflow ใต้ลายเส้น
    function setZenMode(on) {
        zenOn = on;
        document.body.classList.toggle('sp-zen', on);
        if (on) syncZenWidth();
        var b = toolbar.querySelector('[data-sp-act="zen"]');
        if (b) {
            b.classList.toggle('active', on);
            b.title = on ? 'ออกจากโหมดโฟกัส' : 'โหมดโฟกัส (เต็มจอ)';
            var ic = b.querySelector('i');
            if (ic) ic.className = on ? 'fas fa-compress' : 'fas fa-expand';
        }
        // จอเล็ก toolbar ยุบเป็นปุ่มกลมได้ → ปุ่มออกจะหายไป ต้องกางไว้ตลอดใน Zen แล้วคืนสถานะเดิมตอนออก
        if (on) {
            zenPrevCollapsed = toolbar.classList.contains('collapsed');
            toolbar.classList.remove('collapsed');
        } else {
            toolbar.classList.toggle('collapsed', zenPrevCollapsed);
        }
        // วัด anchor ใหม่หลัง layout นิ่ง — renderAll เรียก resizeCanvas + anchorRect ใหม่ทั้งหมดอยู่แล้ว
        requestAnimationFrame(renderAll);
    }

    function initToolbar() {
        var toggle = document.getElementById('scratchpad-toolbar-toggle');
        toolbar.addEventListener('click', function (e) {
            if (swallowPresetClick) { swallowPresetClick = false; return; }
            if (!e.target.closest('.sp-popover')) hidePopover();
            if (!e.target.closest('.sp-flyout, [data-sp-flyout]')) hideFlyout();
            // ปุ่มปรับค่าเอง — เปิด popover ของ "ช่องที่เลือกอยู่" (เดิมต้องกดค้างเท่านั้น จึงแทบไม่มีใครเจอ)
            var ed = e.target.closest('.sp-slot-edit');
            if (ed) {
                var g = presetGroup();
                showPopover(ed.dataset.spEdit, ed.dataset.spEdit === 'color' ? g.ci : g.wi);
                return;
            }
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
                case 'zen': setZenMode(!zenOn); break;
            }
        });
        toolbar.querySelector('.sp-popover').addEventListener('input', onPopoverInput);
        document.getElementById('sp-erase-hl-only').addEventListener('change', function (e) {
            prefs.eraseHlOnly = e.target.checked;
            savePrefs();
        });
        // Phase 3 req 6: ลากแล้ววงยางลบโตตามทันที แต่เขียน localStorage ตอนปล่อย (input ยิงทุกเฟรม)
        var erIn = document.getElementById('sp-eraser-radius');
        erIn.addEventListener('input', function (e) {
            var v = parseFloat(e.target.value);
            if (!(v > 0)) return;
            prefs.eraserRadius = v;
            document.getElementById('sp-eraser-radius-val').textContent = v + 'px';
            requestRender();
        });
        erIn.addEventListener('change', savePrefs);
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
            hideFlyout();
            if (zenOn) return;       // Zen: toolbar ต้องกางไว้ ไม่งั้นปุ่มออกหาย
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
            var rgb = hexToRgb(stroke.color);
            doc.saveGraphicsState();
            if (stroke.tool === 'highlighter') {
                // Q3: ปากกาเน้นยังเป็นเส้นแบนทึบเท่ากันตลอด เหมือนบนจอ (ไม่ผ่าน perfect-freehand)
                if (typeof doc.GState === 'function') doc.setGState(new doc.GState({ opacity: HL_ALPHA }));
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
            } else {
                // Q14: ปากกาใช้ outline polygon ตัวเดียวกับบนจอ (strokeOutline) แค่ส่ง rect เป็น mm → หัวเรียว/ปลายเรียวใน PDF เหมือนที่เห็น
                var outline = strokeOutline(stroke, { x: x, y: y, w: w }, false);
                if (outline.length) {
                    doc.setFillColor(rgb[0], rgb[1], rgb[2]);
                    var poly = [];
                    for (var j = 1; j < outline.length; j++) {
                        poly.push([outline[j][0] - outline[j - 1][0], outline[j][1] - outline[j - 1][1]]);
                    }
                    // closed=true → jsPDF ปิด subpath ด้วย 'h' แล้ว fill แบบ nonzero ('f') เหมือน canvas ctx.fill() — ปลายเรียวที่เส้นตัดกันเองจึงไม่เป็นรู
                    doc.lines(poly, outline[0][0], outline[0][1], [1, 1], 'F', true);
                }
            }
            doc.restoreGraphicsState();
        });
    };
    // Q10b: เทปใน PDF — ยังไม่เปิด = ทึบทับข้อความ (ปิดคำตอบไว้อ่านทวน) ; เปิดแล้ว = กรอบประจางๆ ยังอ่านได้
    window.drawScratchTapesToPdf = function (doc, tapes, anchor, x, y, w) {
        if (!tapes || !tapes.length) return;
        tapes.forEach(function (t) {
            if (t.anchor !== anchor) return;
            var bx = x + t.nx * w, by = y + t.ny * w, bw = t.nw * w, bh = t.nh * w;
            if (bw <= 0 || bh <= 0) return;
            var col = hexToRgb(TAPE_COLORS.light.fill), edge = hexToRgb(TAPE_COLORS.light.edge);
            doc.saveGraphicsState();
            doc.setDrawColor(edge[0], edge[1], edge[2]);
            doc.setFillColor(col[0], col[1], col[2]);
            doc.setLineWidth(0.2);
            if (t.revealed) {
                if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([1, 0.8], 0);
                doc.rect(bx, by, bw, bh, 'S');
                // jsPDF 2.5: restoreGraphicsState ไม่ล้าง dash pattern — ต้องรีเซ็ตเอง ไม่งั้นเส้นถัดไปทั้งไฟล์กลายเป็นเส้นประ
                if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([], 0);
            } else {
                doc.rect(bx, by, bw, bh, 'FD');
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
        // Phase 3: ท่าทางสองนิ้ว — ผูกก่อน onTouchGuard ไม่ได้ (คนละ handler) แต่ onTouchGuard ปล่อยผ่านเมื่อ >1 นิ้วอยู่แล้ว
        wrapper.addEventListener('touchstart', onTwoFingerTouch, { passive: true });
        wrapper.addEventListener('touchmove', onTwoFingerTouch, { passive: true });
        wrapper.addEventListener('touchend', onTwoFingerTouch, { passive: true });
        wrapper.addEventListener('touchcancel', onTwoFingerTouch, { passive: true });
        // Phase 3 req 8: วงยางลบตามเมาส์/ปากกาแม้ยังไม่กด (canvas ปิด pointer-events ตอนว่าง จึงฟังที่ wrapper)
        wrapper.addEventListener('pointermove', function (e) {
            if (tool !== 'eraser' || activeMeta) return;
            var w = wrapper.getBoundingClientRect();
            setEraserCursor(e.clientX - w.left, e.clientY - w.top);
        });
        wrapper.addEventListener('pointerleave', clearEraserCursor);
        document.addEventListener('keydown', onKeyDown);
        window.addEventListener('webkitpencilaction', onPencilAction);
        window.addEventListener('pencilaction', onPencilAction);
        // click ที่หลุดมาหลังยกปากกา (เช่น ตอน capture ล้มเหลวบน WebKit) ห้ามไปกดตัวเลือก
        // Q10: แตะโดนเทป = เปิด/ปิดเทป ไม่ให้ทะลุไปเลือกคำตอบ ; ไม่โดนเทปก็ปล่อยผ่านตามปกติ (ฟังตลอด ไม่ขึ้นกับเครื่องมือ)
        wrapper.addEventListener('click', function (e) {
            if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); return; }
            if (toggleTapeAt(e.clientX, e.clientY)) { e.stopPropagation(); e.preventDefault(); }
        }, true);

        new ResizeObserver(scheduleRender).observe(wrapper);
        window.addEventListener('resize', function () {
            if (zenOn) syncZenWidth();   // หมุนจอตอนอยู่ใน Zen → วัดความกว้างใหม่
            scheduleRender();
        });

        // เปิดให้อ่านการเลือกปัจจุบันได้จากภายนอก (แนวเดียวกับ window.APP._scratchpadState) — ใช้ตอนดีบัก/เทสต์
        window.APP._scratchpadSelection = function () { return selection; };

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
