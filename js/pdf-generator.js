// REFACTOR/js/pdf-generator.js

// ดึงการตั้งค่าพิกัด OMR และ Font จากหน้า Config
const OMR_CONFIG = window.OMR_CONFIG;

// T3.1: Lazy-load TH Sarabun font — โหลด js/th-sarabun-font.js เมื่อส่งออก PDF ครั้งแรก
window.ensureThSarabunFont = function () {
    if (window.thSarabunBase64) return Promise.resolve();
    if (window._thSarabunFontPromise) return window._thSarabunFontPromise;
    window._thSarabunFontPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'js/th-sarabun-font.js';
        s.onload = resolve;
        s.onerror = function () {
            window._thSarabunFontPromise = null; // ล้าง memo เผื่อ retry
            reject(new Error('Failed to load TH Sarabun font script'));
        };
        document.head.appendChild(s);
    });
    return window._thSarabunFontPromise;
};

window.svgToPngBase64 = function (svgString, width = 500, height = 500) {
    return new Promise((resolve, reject) => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);

            const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();

            img.onload = function () {
                const ratio = Math.min(width / img.width, height / img.height);
                const newWidth = img.width * ratio;
                const newHeight = img.height * ratio;
                const offX = (width - newWidth) / 2;
                const offY = (height - newHeight) / 2;

                ctx.drawImage(img, offX, offY, newWidth, newHeight);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = reject;
            img.src = url;
        } catch (e) { reject(e); }
    });
};

window.convertImgToBase64 = function (url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.setAttribute('crossOrigin', 'anonymous');
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const dataURL = canvas.toDataURL('image/jpeg');
            resolve(dataURL);
        };
        img.onerror = (error) => {
            reject(error);
        };
        img.src = url;
    });
};

window.getScaledDimensions = function (imgBase64, maxWidth, maxHeight) {
    return new Promise((resolve) => {
        const img = new Image();
        img.src = imgBase64;
        img.onload = function () {
            let width = img.width;
            let height = img.height;
            const ratio = width / height;

            if (width > maxWidth) {
                width = maxWidth;
                height = width / ratio;
            }
            if (height > maxHeight) {
                height = maxHeight;
                width = height * ratio;
            }
            resolve({ width, height });
        };
        img.onerror = () => resolve({ width: 0, height: 0 });
    });
};

window.updatePdfProgress = function (current, total, startTime) {
    const $widget = $('#pdf-progress-widget');
    if (!$widget.is(':visible')) $widget.fadeIn();

    const progress = Math.round((current / total) * 100);
    const elapsedTime = (Date.now() - startTime) / 1000;
    const avgTimePerItem = elapsedTime / current;
    const remainingItems = total - current;
    const remainingTime = Math.round(avgTimePerItem * remainingItems);
    let timeText = remainingTime > 0 ? `เหลือประมาณ ${remainingTime} วินาที` : "อีกอึดใจเดียว...";

    $('#pdf-pc-text').text(`${progress}%`);
    $('#pdf-bar-fill').css('width', progress + '%');
    $('#pdf-status-text').html(`กำลังประมวลผลข้อที่ <b>${current}/${total}</b><br><small>${timeText}</small>`);

    if (current === total) {
        $('#pdf-status-text').text('เสร็จสิ้น! กำลังดาวน์โหลด...');
        setTimeout(() => {
            $widget.fadeOut(500, function () {
                $('#pdf-pc-text').text('0%');
                $('#pdf-bar-fill').css('width', '0%');
                $('#pdf-status-text').text('กำลังเตรียมข้อมูล...');
            });
        }, 3000);
    }
};

window.saveResultsToPdf = async function () {
    const save = {
        category: [],
        questions: window.APP.currentQuestions,
        score: window.APP.score,
    };
    window.APP.globalStructure.category.forEach(category => {
        const catEl = document.getElementById(`cat-${category.categoryId}`);
        if (catEl && catEl.checked) {
            save.category.push(category.categoryName);
        }
    });

    const totalQuestions = window.APP.currentQuestions.length;
    const startTime = Date.now();
    $('#pdf-pc-text').text('0%');
    $('#pdf-bar-fill').css('width', '0%');
    $('#pdf-progress-widget').fadeIn();

    // T3.1: โหลด font แบบ lazy (ไม่โหลดตั้งแต่ startup)
    await window.ensureThSarabunFont();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

    doc.addFileToVFS('THSarabunNew.ttf', window.thSarabunBase64);
    doc.addFont('THSarabunNew.ttf', 'THSarabunNew', 'normal');
    doc.setFont('THSarabunNew');

    let y = 15;
    const pageMargin = 15;
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    const contentWidth = pageWidth - (pageMargin * 2);
    const lineHeight = 8;
    const itemSpacing = 4;
    const blockSpacing = 12;

    const checkPageBreak = (requiredHeight) => {
        if (y + requiredHeight > pageHeight - pageMargin) {
            doc.addPage();
            y = pageMargin;
        }
    };

    doc.setFontSize(18);
    doc.text("สรุปผลการทำแบบทดสอบ (Quiz Result)", pageWidth / 2, y, { align: 'center' });
    y += lineHeight + itemSpacing;

    doc.setFontSize(16);
    doc.text(`คะแนน: ${window.APP.score}/${save.questions.length}`, pageMargin, y);
    y += blockSpacing;

    // R4: ดึงลายเส้น scratchpad ของวิชานี้ทั้งหมดทีเดียวก่อนเข้าลูป (scratch_<subjectParam>_<qid>) — ไม่ await IndexedDB ทีละข้อ
    const scratchCache = new Map();
    try {
        const scratchPrefix = 'scratch_' + (new URLSearchParams(window.location.search).get('subject') || 'default') + '_';
        const db = await window.openDB();
        const records = await new Promise((resolve, reject) => {
            const req = db.transaction('quiz_cache', 'readonly').objectStore('quiz_cache')
                .getAll(IDBKeyRange.bound(scratchPrefix, scratchPrefix + '￿'));
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        records.forEach(rec => { if (rec && rec.qid) scratchCache.set(rec.qid, rec); });
    } catch (e) { console.warn('[PDF] scratch prefetch failed', e); }

    for (const [index, q] of save.questions.entries()) {
        window.updatePdfProgress(index + 1, totalQuestions, startTime);
        if (index % 2 === 0) await new Promise(r => setTimeout(r, 100));

        // ลายเส้นของข้อนี้ (ถ้ามี) — วาดทับบล็อกโจทย์/รูป/ตัวเลือกที่ตรงกับ anchor บนจอ ; anchor 'card' ไม่มีบล็อกให้ทับ ข้ามไป
        const scratch = scratchCache.get(q.questionId);
        const drawInk = (anchor, x, top, w) => {
            if (!scratch) return;
            // เทปวาดก่อน (ทับข้อความ) แล้วค่อยหมึก — ลำดับเดียวกับบนจอ
            if (typeof window.drawScratchTapesToPdf === 'function') {
                window.drawScratchTapesToPdf(doc, scratch.tapes, anchor, x, top, w);
            }
            if (typeof window.drawScratchStrokesToPdf === 'function') {
                window.drawScratchStrokesToPdf(doc, scratch.strokes, anchor, x, top, w);
            }
        };

        const questionText = `${index + 1}. ${q.problem.replace(/\n/g, ' ')}`;

        const qCategories = Array.isArray(q.category) ? q.category : (q.category ? [q.category] : []);
        const categoryNames = qCategories.map(id => window.getCategoryNameById(id))
            .filter(name => name !== 'Uncategorized' && !name.includes('(Extracted)'));
        const categoryDisplay = categoryNames.length > 0 ? `[${categoryNames[0]}]` : "";

        const splitQuestion = doc.splitTextToSize(questionText, contentWidth);
        let qHeight = splitQuestion.length * (lineHeight - 1);
        if (categoryDisplay) qHeight += 5;

        checkPageBreak(qHeight + blockSpacing);

        doc.setFontSize(16);
        doc.setTextColor(0, 0, 0);
        doc.text(splitQuestion, pageMargin, y);
        drawInk('question', pageMargin, y - 5, contentWidth);
        y += (splitQuestion.length * (lineHeight - 1));

        if (categoryDisplay) {
            y += 2;
            doc.setFontSize(10);
            doc.setTextColor(150);
            doc.text(categoryDisplay, pageMargin + 2, y);
            y += 3;

            doc.setTextColor(0);
            doc.setFontSize(16);
        }

        y += itemSpacing;

        if (q.img) {
            try {
                const imgUrls = q.img.split('///').map(url => url.trim()).filter(Boolean);
                for (const [imgIdx, imgUrl] of imgUrls.entries()) {
                    const base64Img = await window.convertImgToBase64(window.transformUrl(imgUrl));
                    checkPageBreak(60 + itemSpacing);
                    doc.addImage(base64Img, 'JPEG', pageMargin, y, 80, 60);
                    if (imgIdx === 0) drawInk('qimage', pageMargin, y, 80); // บนจอ #image-container-div โชว์รูปแรก
                    y += 60 + itemSpacing;
                }
            } catch (e) { console.error(e); }
        }

        doc.setFont('THSarabunNew', 'normal');
        doc.setFontSize(14);
        doc.text("ตัวเลือก:", pageMargin, y);
        y += lineHeight;

        const choicesArray = (q.choices || "").split('///').map(s => s.trim());
        for (let i = 0; i < choicesArray.length; i++) {
            const choice = choicesArray[i];
            const hasPrefix = /^[A-E]\s*[\.\)]/i.test(choice);
            const prefix = hasPrefix ? "" : `${String.fromCharCode(65 + i)}. `;
            // anchor 'choice:<oidx>' ของ scratchpad นับเฉพาะตัวเลือกที่ไม่ว่าง (quiz-core.js filter(Boolean) ก่อนวาด)
            const choiceAnchor = 'choice:' + choicesArray.slice(0, i).filter(Boolean).length;

            if (choice.startsWith('<svg')) {
                checkPageBreak(15);
                doc.text(prefix, pageMargin, y + 5);
                try {
                    const svgB64 = await window.svgToPngBase64(choice, 100, 100);
                    const xOffset = hasPrefix ? 0 : 10;
                    doc.addImage(svgB64, 'PNG', pageMargin + xOffset, y, 10, 10);
                    drawInk(choiceAnchor, pageMargin, y, contentWidth);
                    y += 12;
                } catch (e) {
                    doc.text("[SVG]", pageMargin + 10, y + 5);
                    y += lineHeight;
                }
            }
            else if (window.isUrl(choice)) {
                checkPageBreak(45);
                doc.text(prefix, pageMargin, y + 5);
                try {
                    const base64C = await window.convertImgToBase64(window.transformUrl(choice));
                    const xOffset = hasPrefix ? 0 : 10;
                    doc.addImage(base64C, 'JPEG', pageMargin + xOffset, y, 50, 40);
                    drawInk(choiceAnchor, pageMargin, y, contentWidth);
                    y += 42;
                } catch (e) {
                    doc.text("[Image Error]", pageMargin + 10, y);
                    y += lineHeight;
                }
            } else {
                const fullText = prefix + choice;
                const splitC = doc.splitTextToSize(fullText, contentWidth);
                checkPageBreak(splitC.length * (lineHeight - 2));
                doc.text(splitC, pageMargin, y);
                drawInk(choiceAnchor, pageMargin, y - 4, contentWidth);
                y += splitC.length * (lineHeight - 2) + 2;
            }
        }
        y += itemSpacing;

        checkPageBreak(30);

        doc.setFontSize(16);
        doc.setTextColor(34, 139, 34);
        if (q.answer.startsWith('<svg')) {
            doc.text("คำตอบที่ถูก: ", pageMargin, y);
            const svgAns = await window.svgToPngBase64(q.answer, 100, 100);
            doc.addImage(svgAns, 'PNG', pageMargin + 30, y - 5, 10, 10);
            y += lineHeight;
        } else if (window.isUrl(q.answer)) {
            doc.text("คำตอบที่ถูก: (รูปภาพด้านล่าง)", pageMargin, y);
            y += lineHeight;
            try {
                const base64Ans = await window.convertImgToBase64(window.transformUrl(q.answer));
                checkPageBreak(45);
                doc.addImage(base64Ans, 'JPEG', pageMargin, y, 50, 40);
                y += 48;
            } catch (e) { }
        } else {
            doc.text(`คำตอบที่ถูก: ${q.answer}`, pageMargin, y);
            y += lineHeight;
        }

        const isCorrect = q.select === q.answer;
        doc.setTextColor(isCorrect ? 34 : 220, 20, 60);
        if (q.select && q.select.startsWith('<svg')) {
            doc.text("คำตอบของคุณ: ", pageMargin, y);
            const svgSel = await window.svgToPngBase64(q.select, 100, 100);
            doc.addImage(svgSel, 'PNG', pageMargin + 30, y - 5, 10, 10);
            y += lineHeight + itemSpacing;
        } else if (window.isUrl(q.select)) {
            doc.text("คำตอบของคุณ: (รูปภาพด้านล่าง)", pageMargin, y);
            y += lineHeight;
            try {
                const base64Sel = await window.convertImgToBase64(window.transformUrl(q.select));
                checkPageBreak(45);
                doc.addImage(base64Sel, 'JPEG', pageMargin, y, 50, 40);
                y += 48;
            } catch (e) {
                doc.text("[ยังไม่ตอบ]", pageMargin, y);
                y += lineHeight;
            }
        } else {
            doc.text(`คำตอบของคุณ: ${q.select || 'ไม่ได้ตอบ'}`, pageMargin, y);
            y += lineHeight + itemSpacing;
        }

        doc.setTextColor(100, 100, 100);
        doc.setFontSize(14);
        y = await window.drawExplanationInPdf(doc, q.explain, pageMargin, pageHeight, contentWidth, lineHeight, blockSpacing, y);

        doc.setDrawColor(220);
        doc.line(pageMargin, y - (blockSpacing / 2), pageWidth - pageMargin, y - (blockSpacing / 2));
    }

    doc.save('MDKKU-Quiz-Result.pdf');
};

window.savePracticeSheetToPdf = async function () {
    if (window.APP.currentQuestions.length === 0) {
        Swal.fire("กรุณาเลือกหัวข้อข้อสอบก่อนทำการบันทึก");
        return;
    }

    const exportFormat = $('#export-format-select').val();
    const useCompactAnswer = $('#key-compact').is(':checked');
    const useDetailedAnswer = $('#key-detailed').is(':checked');
    const dlPngOverlay = $('#dl-png-overlay').is(':checked');

    window.APP.answerKeyMap = [];

    const totalQuestions = window.APP.currentQuestions.length;
    const startTime = Date.now();
    $('#pdf-pc-text').text('0%');
    $('#pdf-bar-fill').css('width', '0%');
    $('#pdf-progress-widget').show();

    // T3.1: โหลด font แบบ lazy (ไม่โหลดตั้งแต่ startup)
    await window.ensureThSarabunFont();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

    doc.addFileToVFS('THSarabunNew.ttf', window.thSarabunBase64);
    doc.addFont('THSarabunNew.ttf', 'THSarabunNew', 'normal');
    doc.setFont('THSarabunNew', 'normal');

    let y = OMR_CONFIG.margin;
    const pageMargin = OMR_CONFIG.margin;
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    const contentWidth = pageWidth - (pageMargin * 2);
    const lineHeight = 7;

    const checkPageBreak = (requiredHeight) => {
        if (y + requiredHeight > pageHeight - pageMargin) {
            doc.addPage();
            y = pageMargin;
        }
    };

    doc.setFontSize(20);
    doc.text("MDKKUQUIZ - ชุดข้อสอบสำหรับทบทวน", pageWidth / 2, y, { align: 'center' });
    y += 15;

    for (const [index, q] of window.APP.currentQuestions.entries()) {
        window.updatePdfProgress(index + 1, totalQuestions, startTime);
        if (index % 3 === 0) await new Promise(r => setTimeout(r, 1));

        const qCategories = Array.isArray(q.category) ? q.category : (q.category ? [q.category] : []);
        const categoryNames = qCategories.map(id => window.getCategoryNameById(id))
            .filter(name => name !== 'Uncategorized' && !name.includes('(Extracted)'));
        const firstCategoryDisplay = categoryNames.length > 0 ? `[${categoryNames[0]}]` : "ไม่มี";

        const questionText = `${index + 1}. ${q.problem.replace(/\n/g, ' ')}`;
        doc.setFontSize(16);
        const prefixLines = doc.splitTextToSize(questionText, contentWidth);

        let estimatedHeight = prefixLines.length * lineHeight;
        if (firstCategoryDisplay) estimatedHeight += 5;

        let processedImgs = [];
        if (q.img) {
            const urls = q.img.split('///').map(u => u.trim()).filter(Boolean);
            for (const url of urls) {
                try {
                    const base64 = await window.convertImgToBase64(window.transformUrl(url));
                    const dims = await window.getScaledDimensions(base64, contentWidth - 20, 100);
                    processedImgs.push({ base64, dims });
                    estimatedHeight += dims.height + 5;
                } catch (e) { console.error("Image load fail", e); }
            }
        }

        const choices = (q.choices || "").split('///').map(s => s.trim()).filter(Boolean);
        let processedChoices = [];
        for (const c of choices) {
            if (c.startsWith('<svg')) {
                try {
                    const svgB64 = await window.svgToPngBase64(c, 100, 100);
                    processedChoices.push({ content: svgB64, dims: { width: 10, height: 10 }, isImg: true });
                    estimatedHeight += 12;
                } catch (e) {
                    processedChoices.push({ content: "[SVG]", isImg: false });
                    estimatedHeight += lineHeight;
                }
            } else if (window.isUrl(c)) {
                try {
                    const b64 = await window.convertImgToBase64(window.transformUrl(c));
                    const d = await window.getScaledDimensions(b64, 50, 40);
                    processedChoices.push({ content: b64, dims: d, isImg: true });
                    estimatedHeight += d.height + 2;
                } catch (e) { processedChoices.push({ content: c, isImg: false }); estimatedHeight += lineHeight; }
            } else {
                processedChoices.push({ content: c, isImg: false });
                estimatedHeight += doc.splitTextToSize(c, contentWidth - 10).length * lineHeight;
            }
        }

        checkPageBreak(estimatedHeight + 10);

        doc.setTextColor(0);
        doc.setFontSize(16);
        prefixLines.forEach(line => {
            doc.text(line, pageMargin, y);
            y += lineHeight;
        });

        if (firstCategoryDisplay) {
            doc.setFontSize(10);
            doc.setTextColor(150);
            doc.text(firstCategoryDisplay, pageMargin + 2, y - 2);
            y += 4;
            doc.setTextColor(0);
            doc.setFontSize(16);
        }

        processedImgs.forEach(imgData => {
            doc.addImage(imgData.base64, 'JPEG', pageMargin + (contentWidth - imgData.dims.width) / 2, y, imgData.dims.width, imgData.dims.height);
            y += imgData.dims.height + 5;
        });

        processedChoices.forEach((choice, i) => {
            const label = `${String.fromCharCode(65 + i)}. `;
            if (choice.isImg) {
                doc.text(label, pageMargin + 5, y + 5);
                doc.addImage(choice.content, 'JPEG', pageMargin + 15, y, choice.dims.width, choice.dims.height);
                y += choice.dims.height + 2;
            } else {
                const lines = doc.splitTextToSize(label + choice.content, contentWidth - 10);
                lines.forEach(l => {
                    doc.text(l, pageMargin + 5, y);
                    y += lineHeight;
                });
            }
        });
        y += 5;
    }

    if (exportFormat === 'omr') {
        doc.addPage();
        window.drawFiducials(doc);
        y = OMR_CONFIG.margin + 10;
        doc.setFontSize(22);
        doc.text("กระดาษคำตอบ (Answer Sheet)", pageWidth / 2, y, { align: 'center' });
        y += 15;

        const startY = y;
        const maxRowsPerCol = Math.floor((pageHeight - startY - 30) / OMR_CONFIG.rowHeight);
        let currentQCount = 0;

        const embedHiddenData = (fullMap) => {
            if (fullMap.length === 0) return;
            const currentPage = doc.internal.getNumberOfPages();
            const pageData = fullMap.filter(m => m.page === currentPage);

            doc.setTextColor(255, 255, 255);
            doc.setFontSize(2);
            const jsonData = JSON.stringify(pageData);
            const splitData = doc.splitTextToSize(`[MDKKU_OMR_DATA]${jsonData}[/MDKKU_OMR_DATA]`, 190);
            doc.text(splitData, 10, 285);
            doc.setTextColor(0);
        };

        for (let i = 0; i < window.APP.currentQuestions.length; i++) {
            const q = window.APP.currentQuestions[i];
            window.updatePdfProgress(i + 1, totalQuestions, startTime);
            if (i % 2 === 0) await new Promise(r => setTimeout(r, 100));
            const col = Math.floor(currentQCount / maxRowsPerCol);

            if (col >= OMR_CONFIG.maxCols) {
                embedHiddenData(window.APP.answerKeyMap);
                doc.addPage();
                window.drawFiducials(doc);
                currentQCount = 0;
                y = OMR_CONFIG.margin + 15;
            }

            const actualCol = Math.floor(currentQCount / maxRowsPerCol);
            const actualRow = currentQCount % maxRowsPerCol;
            const cellX = (pageMargin + 5) + (actualCol * OMR_CONFIG.colWidth);
            const cellY = startY + (actualRow * OMR_CONFIG.rowHeight);

            doc.setFontSize(11);
            doc.text(`${i + 1}.`, cellX, cellY + 1);

            const choicesArray = (q.choices || "").split('///').map(s => s.trim()).filter(Boolean);
            const answerIndex = choicesArray.indexOf(q.answer);
            const numBubbles = Math.max(choicesArray.length, 4);
            const correctBubbleX = cellX + 8 + (answerIndex * OMR_CONFIG.bubbleSpacingX);

            window.APP.answerKeyMap.push({
                page: doc.internal.getNumberOfPages(),
                qNum: i + 1,
                correctLetter: String.fromCharCode(65 + answerIndex),
                numChoices: numBubbles,
                startX: cellX + 8,
                x: correctBubbleX,
                y: cellY
            });

            for (let b = 0; b < Math.min(numBubbles, 5); b++) {
                const bx = cellX + 8 + (b * OMR_CONFIG.bubbleSpacingX);
                doc.setDrawColor(180);
                doc.circle(bx, cellY, OMR_CONFIG.bubbleRadius, 'S');
                doc.setFontSize(7);
                doc.setTextColor(180);
                doc.text(String.fromCharCode(65 + b), bx - 0.8, cellY + 0.8);
            }
            currentQCount++;
        }
        embedHiddenData(window.APP.answerKeyMap);
    }

    if (useCompactAnswer || useDetailedAnswer) {
        doc.addPage();
        y = pageMargin;
        doc.setFontSize(20);
        doc.text("Answer Key (เฉลย)", pageWidth / 2, y, { align: 'center' });
        y += 15;

        if (useCompactAnswer) {
            doc.setFontSize(16);
            doc.text("ส่วนที่ 1: เฉลยแบบย่อ", pageMargin, y);
            y += 10;

            const answers = [];
            const keyStartTime = Date.now();
            for (let i = 0; i < window.APP.currentQuestions.length; i++) {
                window.updatePdfProgress(i + 1, window.APP.currentQuestions.length, keyStartTime);
                const q = window.APP.currentQuestions[i];
                const choicesArray = (q.choices || "").split('///').map(s => s.trim());
                const answerIndex = choicesArray.indexOf(q.answer);

                let imgBase64 = null;
                let displayLetter = answerIndex !== -1 ? String.fromCharCode(65 + answerIndex) : "";

                if (q.answer.startsWith('<svg')) {
                    imgBase64 = await window.svgToPngBase64(q.answer, 100, 100);
                } else if (window.isUrl(q.answer)) {
                    try {
                        imgBase64 = await window.convertImgToBase64(window.transformUrl(q.answer));
                    } catch (e) { console.error("Error loading key image for question " + (i + 1), e); }
                }

                answers.push({
                    index: i + 1,
                    letter: displayLetter,
                    imgData: imgBase64
                });
            }
            const columns = 5;
            const cellWidth = contentWidth / columns;
            const cellHeight = 12;

            for (let i = 0; i < answers.length; i++) {
                const item = answers[i];
                const col = i % columns;

                if (col === 0) {
                    if (y + cellHeight > pageHeight - pageMargin) {
                        doc.addPage();
                        y = pageMargin + 10;

                        doc.setFontSize(14);
                        doc.setTextColor(100);
                        doc.text("(เฉลยแบบย่อ - ต่อ)", pageWidth / 2, y - 5, { align: 'center' });
                        doc.setTextColor(0);
                    }
                }

                const x = pageMargin + (col * cellWidth);
                const currentDrawY = y;

                doc.setDrawColor(200);
                doc.rect(x, currentDrawY, cellWidth, cellHeight);

                doc.setFontSize(12);
                doc.setTextColor(0);
                const numText = `${item.index}. `;
                doc.text(numText, x + 2, currentDrawY + (cellHeight / 2) + 1);

                const numWidth = doc.getTextWidth(numText);

                if (item.imgData) {
                    doc.addImage(item.imgData, 'PNG', x + numWidth + 2, currentDrawY + 2, 8, 8);
                } else {
                    doc.setFontSize(14);
                    doc.text(item.letter, x + numWidth + 2, currentDrawY + (cellHeight / 2) + 1);
                }

                if (col === columns - 1) {
                    y += cellHeight;
                } else if (i === answers.length - 1) {
                    y += cellHeight;
                }
            }
            y += 10;
        }

        if (useDetailedAnswer) {
            checkPageBreak(20);
            doc.setFontSize(16);
            doc.setTextColor(0);
            doc.text("ส่วนที่ 2: เฉลยแบบละเอียด (พร้อมคำอธิบาย)", pageMargin, y);
            y += 10;

            for (const [index, q] of window.APP.currentQuestions.entries()) {
                const explainText = q.explain || 'ไม่มีคำอธิบาย';
                checkPageBreak(lineHeight * 3);

                doc.setFontSize(16);
                doc.setTextColor(0, 100, 0);

                if (q.answer.startsWith('<svg')) {
                    doc.text(`${index + 1}. คำตอบ: `, pageMargin, y);
                    try {
                        const svgKey = await window.svgToPngBase64(q.answer, 100, 100);
                        doc.addImage(svgKey, 'PNG', pageMargin + 25, y - 5, 10, 10);
                    } catch (e) { doc.text("[SVG]", pageMargin + 25, y); }
                } else if (window.isUrl(q.answer)) {
                    doc.text(`${index + 1}. คำตอบ: `, pageMargin, y);
                    try {
                        const imgKey = await window.convertImgToBase64(window.transformUrl(q.answer));
                        doc.addImage(imgKey, 'JPEG', pageMargin + 25, y - 5, 10, 10);
                    } catch (e) { doc.text("[รูปภาพ]", pageMargin + 25, y); }
                } else {
                    doc.text(`${index + 1}. คำตอบ: ${q.answer}`, pageMargin, y);
                }

                y += lineHeight;

                doc.setFontSize(14);
                doc.setTextColor(80, 80, 80);
                y = await window.drawExplanationInPdf(doc, q.explain, pageMargin, pageHeight, contentWidth - 5, lineHeight, 8, y);
                doc.setTextColor(0);
            }
        }
    }

    doc.save('MDKKU-Quiz-Practice.pdf');
    $('#pdf-status-text').text('เสร็จสิ้น! กำลังดาวน์โหลด...');
    setTimeout(() => {
        $('#pdf-progress-widget').fadeOut(500, function () {
            $('#pdf-pc-text').text('0%');
            $('#pdf-bar-fill').css('width', '0%');
            $('#pdf-status-text').text('กำลังเตรียมข้อมูล...');
        });
    }, 2000);
    if (exportFormat === 'omr' && dlPngOverlay) {
        setTimeout(() => window.generatePNGOverlays(), 1500);
    }
};

window.drawFiducials = function (doc) {
    doc.setFillColor(0, 0, 0);
    const s = OMR_CONFIG.fiducialSize;
    const m = OMR_CONFIG.fiducialMargin;
    const w = OMR_CONFIG.a4Width;
    const h = OMR_CONFIG.a4Height;

    doc.rect(m, m, s, s, 'F');
    doc.rect(w - m - s, m, s, s, 'F');
    doc.rect(m, h - m - s, s, s, 'F');
    doc.rect(w - m - s, h - m - s, s, s, 'F');
};

window.generatePNGOverlays = function () {
    if (window.APP.answerKeyMap.length === 0) return;

    const DPI = 150;
    const scale = DPI / 25.4;

    const pages = [...new Set(window.APP.answerKeyMap.map(item => item.page))];

    pages.forEach(pageNum => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(OMR_CONFIG.a4Width * scale);
        canvas.height = Math.round(OMR_CONFIG.a4Height * scale);
        const ctx = canvas.getContext('2d');

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const pageAnswers = window.APP.answerKeyMap.filter(ans => ans.page === pageNum);

        pageAnswers.forEach(ans => {
            ctx.beginPath();
            ctx.arc(ans.x * scale, ans.y * scale, OMR_CONFIG.bubbleRadius * scale, 0, 2 * Math.PI);

            ctx.fillStyle = 'rgba(255, 0, 0, 0.4)';
            ctx.fill();

            ctx.lineWidth = 3;
            ctx.strokeStyle = 'red';
            ctx.stroke();
        });

        const link = document.createElement('a');
        link.download = `MDKKU_Overlay_Page_${pageNum}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    });
};

window.drawExplanationInPdf = async function (doc, explainRaw, pageMargin, pageHeight, contentWidth, lineHeight, blockSpacing, initY) {
    let currentY = initY;
    const parsed = window.parseExplain(explainRaw);

    const checkLocalPageBreak = (requiredHeight) => {
        if (currentY + requiredHeight > pageHeight - pageMargin) {
            doc.addPage();
            currentY = pageMargin;
        }
    };

    // 1. Text explanation
    const explainText = `คำอธิบาย: ${parsed.text || 'ไม่มี'}`;
    const splitExplain = doc.splitTextToSize(explainText, contentWidth);
    const calculatedLineHeight = lineHeight - 2 > 4 ? lineHeight - 2 : 5;
    checkLocalPageBreak(splitExplain.length * calculatedLineHeight);
    doc.text(splitExplain, pageMargin, currentY);
    currentY += (splitExplain.length * calculatedLineHeight) + 4;

    // 2. Media rendering
    if (parsed.media && parsed.media.length > 0) {
        for (const url of parsed.media) {
            const type = window.getMediaType(url);

            if (type === 'pdf') {
                // Hyperlink
                checkLocalPageBreak(8);
                doc.setTextColor(0, 0, 238); // Blue color for link
                const linkText = "[เปิดดูไฟล์เอกสารประกอบ PDF บนบราวเซอร์]";
                doc.text(linkText, pageMargin + 5, currentY);
                const textWidth = doc.getTextWidth(linkText);
                doc.link(pageMargin + 5, currentY - 4, textWidth, 6, { url: window.transformUrl(url) });
                doc.setTextColor(0);
                currentY += 8;
            } else if (type === 'svg') {
                try {
                    checkLocalPageBreak(44);
                    const svgB64 = await window.svgToPngBase64(url, 150, 150);
                    doc.addImage(svgB64, 'PNG', pageMargin + 5, currentY, 40, 40);
                    currentY += 44;
                } catch (e) {
                    console.error("Error drawing explain SVG inside PDF", e);
                }
            } else { // image
                try {
                    checkLocalPageBreak(64);
                    const base64Img = await window.convertImgToBase64(window.transformUrl(url));
                    doc.addImage(base64Img, 'JPEG', pageMargin + 5, currentY, 80, 60);
                    currentY += 64;
                } catch (e) {
                    console.error("Error drawing explain Image inside PDF", e);
                }
            }
        }
    }

    currentY += blockSpacing - 4;
    return currentY;
};