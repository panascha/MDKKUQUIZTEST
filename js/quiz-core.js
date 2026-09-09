// REFACTOR/js/quiz-core.js — Navigation & question lifecycle

// 1. ระบบจัดการภาพรวมชุดข้อสอบ (Index Panel)
window.renderIndexPanel = function () {
    if (typeof window.APP.currentQuestions === 'undefined' || !window.APP.currentQuestions.length) return;

    const $grid = $('#index-dot-grid');
    $grid.empty();

    let correct = 0, wrong = 0;
    window.APP.currentQuestions.forEach((q, idx) => {
        let cls = 'index-dot';
        let title = `ข้อที่ ${idx + 1}`;

        if (idx === window.APP.questionIndex) {
            cls += ' idx-current';
            title += ' (ปัจจุบัน)';
        } else if (q.state) {
            if (q.select === q.answer) {
                cls += ' idx-correct';
                correct++;
                title += ' ✓ ถูก';
            } else {
                cls += ' idx-wrong';
                wrong++;
                title += ' ✗ ผิด';
            }
        }

        $grid.append(
            `<div class="${cls}" title="${title}" onclick="window.jumpToQuestion(${idx})">${idx + 1}</div>`
        );
    });

    let totalCorrect = window.APP.currentQuestions.filter(q => q.state && q.select === q.answer).length;
    let totalAnswered = window.APP.currentQuestions.filter(q => q.state).length;
    $('#index-score-badge-header').text(`${totalCorrect} / ${totalAnswered}`);
};

window.jumpToQuestion = function (index) {
    if (index < 0 || index >= window.APP.currentQuestions.length) return;
    window.APP.questionIndex = index;
    window.showQuestion();
    window.updateProgressHeader();
    window.showSubmission($('#submission-filter').val());
};

// 2. ระบบดาวน์โหลดภาพคำถามล่วงหน้า (Image Preloader)
window.preloadQuizImages = function (questions) {
    if (!questions || questions.length === 0) return;

    questions.forEach(q => {
        if (q.img) {
            const urls = q.img.split('///').map(u => window.transformUrl(u.trim())).filter(Boolean);
            urls.forEach(url => {
                if (!window.APP.preloadedImages[url]) {
                    const img = new Image();
                    img.src = url;
                    window.APP.preloadedImages[url] = img;
                }
            });
        }

        if (q.choices) {
            const choicesArray = q.choices.split("///").map(s => s.trim()).filter(Boolean);
            choicesArray.forEach(choice => {
                if (window.isUrl(choice)) {
                    const url = window.transformUrl(choice);
                    if (!window.APP.preloadedImages[url]) {
                        const img = new Image();
                        img.src = url;
                        window.APP.preloadedImages[url] = img;
                    }
                }
            });
        }

        if (q.explain) {
            const parsedExp = window.parseExplain(q.explain);
            parsedExp.media.forEach(url => {
                if (window.getMediaType(url) === 'image') {
                    const trans = window.transformUrl(url);
                    if (!window.APP.preloadedImages[trans]) {
                        const img = new Image();
                        img.src = trans;
                        window.APP.preloadedImages[trans] = img;
                    }
                }
            });
        }
    });
    console.log("Preloading started for " + questions.length + " questions...");
};

// 3. ระบบแสดงคำถาม (Show Question)
// แก้ข้อมูลข้อสอบในเครื่องทั้ง allQuestions และ currentQuestions (คนละสำเนากัน)
// ห้ามใช้ updateQuestionSet() แทน — มันสร้างชุดข้อสอบใหม่ทั้งชุด ทำให้ลำดับข้อที่กำลังทำอยู่รีเซ็ตเป็นลำดับฐานข้อมูล
// forEach ไม่ใช่ find เพราะโหมดทวนข้อผิดใส่ข้อเดิมซ้ำในชุดได้มากกว่าหนึ่งครั้ง
window.applyQuestionPatchLocally = function (qId, patch) {
    const localQ = window.APP.allQuestions.find(q => q.questionId === qId);
    if (localQ) Object.assign(localQ, patch);
    window.APP.currentQuestions.forEach(q => {
        if (q.questionId === qId) Object.assign(q, patch);
    });
};

window.showQuestion = function (shouldFocus = true) {
    if (!window.APP.currentQuestions.length) return;

    window.questionStartTime = Date.now();
    window.APP.current_question = window.APP.currentQuestions[window.APP.questionIndex];

    window.APP.current_question.attemptCount = window.APP.current_question.attemptCount || 0;
    window.APP.current_question.failCount = window.APP.current_question.failCount || 0;

    let statusColor = "#dc3545";
    let statusSuffix = "";

    if (window.APP.current_question.state && window.APP.current_question.select === window.APP.current_question.answer) {
        statusColor = "#198754";
        statusSuffix = " | สถานะ: ทำถูกแล้ว ✅";
    }

    // ==========================================
    // 1. สั่งล้างคำอธิบายเฉลยและ Feedback เก่าทิ้งทันทีเมื่อเปลี่ยนข้อ
    // ==========================================
    $('#feedback').empty().removeClass();
    $('#quiz-explain-container').empty();
    $('#choices').empty();

    $('#vote-notification-bar').empty();
    if (window.APP.pendingVotesCache[window.APP.current_question.questionId]) {
        window.renderVoteNotificationUI(window.APP.current_question.questionId, window.APP.pendingVotesCache[window.APP.current_question.questionId]);
    }
    // T1.1: per-qid fetch เฉพาะกรณี bulk ยังไม่เสร็จ (fallback สำหรับข้อปัจจุบัน)
    if (!window._bulkPendingLoaded && !window._bulkPendingInFlight) {
        window.fetchPendingVotes(window.APP.current_question.questionId);
    }

    $('#report-notification-bar').empty();
    if (window.APP.pendingReportsCache[window.APP.current_question.questionId]) {
        window.renderReportNotificationUI(window.APP.current_question.questionId, window.APP.pendingReportsCache[window.APP.current_question.questionId]);
    }
    // T1.1: per-qid fetch เฉพาะกรณี bulk ยังไม่เสร็จ (fallback สำหรับข้อปัจจุบัน)
    if (!window._bulkPendingLoaded && !window._bulkPendingInFlight) {
        window.fetchPendingReports(window.APP.current_question.questionId);
    }

    let categoryName = "";
    window.APP.current_question.category.forEach(catId => {
        const catObj = window.APP.globalStructure.category.find(c => c.categoryId === catId);
        if (catObj) {
            categoryName += (categoryName ? "<br>" : "") + (window.APP.current_question.category.indexOf(catId) + 1) + ". " + catObj.categoryName;
        }
    });
    $('#categoryquestion').html(categoryName ? `หัวข้อ: <b>${categoryName}</b>` : "หัวข้อ: <b>ไม่ระบุหัวข้อ</b>");
    $('#btn-copy-question-ai').show();
    $('#question').html(window.APP.current_question.problem ? window.APP.current_question.problem.replace(/\n/g, '<br>') : "");

    window.APP.currentImageArray = window.APP.current_question.img ?
        (window.APP.current_question.img.includes('///') ? window.APP.current_question.img.split('///') : [window.APP.current_question.img])
        : [];
    window.APP.currentImageIndex = 0;
    window.updateImageGallery();

    const choicesRaw = window.APP.current_question.choices || "";
    const choicesArray = choicesRaw.split("///").map(s => s.trim()).filter(Boolean);

    // ลำดับตัวเลือกจำไว้ต่อ questionId — วาดหน้าจอใหม่กี่ครั้ง (ซิงค์ / โหวต / MEQ / ส่งคำตอบ) ก็ไม่สลับซ้ำ
    // sig ผูกกับ choices+answer: ถ้าเนื้อหาข้อถูกแก้หรือซิงค์มาใหม่ ให้ทิ้งลำดับเดิมแล้วสุ่มใหม่ (กัน index ค้างเกินจำนวนตัวเลือก)
    // sig สร้างจาก choicesArray ที่ trim แล้ว ไม่ใช่ choicesRaw — ช่องว่างรอบตัวเลือกที่เปลี่ยนไม่ควรทำให้ลำดับสุ่มใหม่
    // เฉลยอาจเป็น base64/SVG ยาวเป็นหมื่นตัว — เก็บแค่ความยาว+50 ตัวแรก (ใส่ความยาวด้วยกัน prefix ซ้ำของ base64 ชนกัน)
    const rawAnswer = window.APP.current_question.answer || "";
    const answerKey = rawAnswer.length > 50 ? rawAnswer.length + ":" + rawAnswer.slice(0, 50) : rawAnswer;
    const orderSig = choicesArray.join("///") + "|#ANS#|" + answerKey;
    const orderQid = window.APP.current_question.questionId;
    let choiceMemo = window.APP._choiceOrderByQid[orderQid];
    if (!choiceMemo || choiceMemo.sig !== orderSig) {
        const order = choicesArray.map((_, i) => i);
        // สุ่มเฉพาะข้อที่ยังไม่ได้ตอบ — ข้อที่ตอบไปแล้ว (เช่นกู้คืน session) คงลำดับตามฐานข้อมูล
        if (!window.APP.current_question.state) {
            for (let i = order.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [order[i], order[j]] = [order[j], order[i]];
            }
        }
        choiceMemo = { sig: orderSig, order: order, allowed: null };
        window.APP._choiceOrderByQid[orderQid] = choiceMemo;
    }
    // ตอบแล้ว → คงลำดับตามฐานข้อมูลเสมอ / ยังไม่ตอบ → ใช้ลำดับสุ่มที่จำไว้ (คงที่ระหว่างวาดซ้ำ)
    const indices = window.APP.current_question.state
        ? choicesArray.map((_, i) => i)
        : choiceMemo.order;

    let allowedOriginalIndices = [];
    if (window.APP.isFastMode && !window.APP.current_question.state) {
        // ตัวลวงที่ไม่ถูกจางก็จำไว้ด้วย ไม่งั้นวาดใหม่ทีไรก็สุ่มตัวลวงใหม่ทุกครั้ง
        if (!choiceMemo.allowed) {
            const correctOriginalIdx = choicesArray.indexOf(window.APP.current_question.answer);
            if (correctOriginalIdx !== -1) {
                const incorrectOriginalIndices = choicesArray.map((_, idx) => idx).filter(idx => idx !== correctOriginalIdx);
                if (incorrectOriginalIndices.length > 0) {
                    const randomIncorrectIdx = incorrectOriginalIndices[Math.floor(Math.random() * incorrectOriginalIndices.length)];
                    choiceMemo.allowed = [correctOriginalIdx, randomIncorrectIdx];
                }
            }
        }
        allowedOriginalIndices = choiceMemo.allowed || [];
    }

    indices.forEach((i, idx) => {
        const choiceText = choicesArray[i];

        // ล้างลบตัวเลือกหัวข้อ A-E เดิมที่ติดมาจากฐานข้อมูลออกก่อน (ถ้ามี) เพื่อป้องกันการตีกันของหัวข้อตอนสลับลำดับ
        const cleanChoiceText = choiceText.replace(/^[A-E]\s*[\.\)]\s*/i, "");
        const letter = String.fromCharCode(65 + idx);
        let content = cleanChoiceText;

        if (window.isUrl(cleanChoiceText)) {
            content = `<img src="${window.transformUrl(cleanChoiceText)}" alt="Choice">`;
        } else if (cleanChoiceText.startsWith('<svg')) {
            content = `<div class="svg-choice-container" style="display:inline-block; vertical-align:middle;">${cleanChoiceText}</div>`;
        }
        const $btn = $('<button></button>');
        // เก็บคำตอบต้นฉบับเต็มไว้ใช้ตรวจสอบกับคำเฉลย (ห้ามตัด Prefix ออกจากแอตทริบิวต์ data-answer เพื่อความถูกต้องในการตรวจเฉลย)
        $btn.attr('data-answer', choiceText);
        // ลำดับดั้งเดิมใน choicesArray (ไม่ใช่ตำแหน่งที่แสดงผล) — scratchpad.js ผูกลายเส้นไว้กับตัวเลือกนี้
        // ผูกกับ i ทำให้สลับลำดับตัวเลือกกี่ครั้ง ลายเส้นก็ยังตามเนื้อหาตัวเลือกเดิมเสมอ
        $btn.attr('data-oidx', i);
        // .choice-badge = วงกลมตัวอักษร A-E — scratchpad.js ใช้เป็นเป้าฝนปากกาเพื่อเลือกคำตอบ
        // เนื้อหาห่อใน .choice-text เดียว — glossary <span> ที่ markGlossaryTerms แทรก จะอยู่ inline ข้างใน
        // ไม่กลายเป็น flex item แยกของปุ่ม (ปุ่มเป็น display:flex) ที่ทำให้ตัวเลือกแตกเป็นคอลัมน์
        $btn.html('<span class="choice-badge" data-choice-idx="' + idx + '">' + letter + '</span><span class="choice-text">' + content + '</span>');

        if (window.APP.isFastMode && !window.APP.current_question.state && allowedOriginalIndices.length > 0) {
            if (!allowedOriginalIndices.includes(i)) {
                $btn.addClass('faded-choice');
            }
        }

        $('#choices').append($btn);
    });

    // ==========================================
    // 2. ตรวจสอบสถานะเพื่อแสดงคำอธิบายเฉลยเฉพาะของข้อปัจจุบัน
    // ==========================================
    if (window.APP.current_question.state) {
        // หากผู้เรียนเคยทำข้อนี้ไปแล้ว -> แสดงเฉลย และดึงคำอธิบายเฉลยของข้อนี้ขึ้นมาวาดใหม่
        window.checkAnswerUI(window.APP.current_question.select, false);
        window.renderExplainMediaInQuiz(window.APP.current_question.explain, '#quiz-explain-container');
    } else if (window.APP.isShowingAllAnswers) {
        // หากเปิดโหมดแสดงเฉลยล่วงหน้า -> บังคับแสดงเฉลย และคำอธิบายเฉลยของข้อนี้ทันที
        $('#choices').find(`button[data-answer="${window.APP.current_question.answer}"]`).addClass('correct');
        $('#feedback').addClass('correct').html(`เฉลย: ${window.displayAnswerContent(window.APP.current_question.answer)}`);
        window.renderExplainMediaInQuiz(window.APP.current_question.explain, '#quiz-explain-container');
    }

    $('#questionIndex').text(`${window.APP.questionIndex + 1}/${window.APP.currentQuestions.length}`);

    if (window.APP.pendingVotesCache[window.APP.current_question.questionId]) {
        window.renderVoteNotificationUI(window.APP.current_question.questionId, window.APP.pendingVotesCache[window.APP.current_question.questionId]);
    }
    // T1.1: per-qid fetch เฉพาะกรณี bulk ยังไม่เสร็จ
    if (!window._bulkPendingLoaded && !window._bulkPendingInFlight) {
        window.fetchPendingVotes(window.APP.current_question.questionId);
    }

    // Sync Edit Mode button status
    if (window.EDIT_SESSION && window.EDIT_SESSION.isLoggedIn) {
        $('#btn-edit-current-q').show();
    } else {
        $('#btn-edit-current-q').hide();
    }

    if (shouldFocus) {
        // ... (focus choices) ...
        $('#choices').find('button').first().trigger('focus', { preventScroll: true });
    }
    setTimeout(window.renderAllMath, 50);
};

// 4. ระบบการเดินหน้า / ถอยหลังของคำถาม
window.nextQuestion = function () {
    if (window.APP.questionIndex < window.APP.currentQuestions.length - 1) {
        window.APP.questionIndex++;
        window.showQuestion();
    } else {
        Swal.fire("นี่คือข้อสุดท้ายแล้ว!");
    }
    window.updateProgressHeader();
    window.saveProgressToCache();
    window.showSubmission($('#submission-filter').val());
};

window.prevQuestion = function () {
    if (window.APP.questionIndex > 0) {
        window.APP.questionIndex--;
        window.showQuestion();
        window.updateProgressHeader();
        window.saveProgressToCache();
        window.showSubmission($('#submission-filter').val());
    }
};

// 5. ระบบส่งคำตอบและคำนวณคะแนน
window.submitQuestion = function () {
    if (window.APP.current_question.state) return;

    const $selectedBtn = $('#choices').find("button.selected");
    const selectedAnswer = $selectedBtn.attr('data-answer');

    if (!selectedAnswer) {
        Swal.fire("กรุณาเลือกคำตอบ");
        return;
    }

    window.APP.current_question.attemptCount = (window.APP.current_question.attemptCount || 0) + 1;
    window.APP.currentQuestions[window.APP.questionIndex].select = selectedAnswer;
    window.APP.currentQuestions[window.APP.questionIndex].state = true;

    if (selectedAnswer === window.APP.current_question.answer) {
        window.APP.score++;
    } else {
        window.APP.current_question.failCount = (window.APP.current_question.failCount || 0) + 1;

        if (window.APP.isReviewMode) {
            const retryQuestion = {
                ...window.APP.current_question,
                state: false,
                select: ""
            };

            const min = window.APP.questionIndex + 1;
            const max = window.APP.currentQuestions.length;
            const insertAt = Math.floor(Math.random() * (max - min + 1)) + min;

            window.APP.currentQuestions.splice(insertAt, 0, retryQuestion);
        }
    }

    $('#score').text(`${window.APP.score}/${window.APP.currentQuestions.length}`);
    $('#questionIndex').text(`${window.APP.questionIndex + 1}/${window.APP.currentQuestions.length}`);

    // วาดตัวเลือกใหม่โดยคงลำดับเดิมไว้ (ลำดับถูกจำไว้ใน window.APP._choiceOrderByQid แล้ว) — ตัวเลือกจะไม่กระโดดสลับตอนส่งคำตอบ
    window.showQuestion(false);

    if (selectedAnswer !== window.APP.current_question.answer && window.APP.isReviewMode) {
        $('#feedback').append(`<div style="font-size: 0.8em; color: #721c24;">* ข้อนี้ถูกเพิ่มกลับเข้าไปในชุดคำถามเพื่อให้คุณแก้ตัวอีกครั้ง</div>`);
    }

    window.showSubmission($('#submission-filter').val());
    window.updateProgressHeader();
    setTimeout(window.renderAllMath, 50);
    window.saveProgressToCache();

    setTimeout(() => {
        if (window.APP.sessionAutoVoteCount >= window.MAX_AUTO_VOTE) return;

        let cats = Array.isArray(window.APP.current_question.category) ? window.APP.current_question.category : [window.APP.current_question.category];
        cats = cats.filter(c => c && c !== 'Uncategorized');
        if (cats.length > 1) return;

        let isExcluded = false;
        if (window.APP.globalStructure.category) {
            cats.forEach(catId => {
                const catObj = window.APP.globalStructure.category.find(c => c.categoryId === catId);
                if (catObj) {
                    const groupName = (catObj.accordionGroup || "").toUpperCase();
                    const catName = (catObj.categoryName || "").toUpperCase();

                    const isExcludedGroupName = groupName.includes("LEC") ||
                        groupName.includes("BY AI") ||
                        groupName.includes("(EXTRACTED)");

                    const isExcludedCatName = catName.includes("MODULE") ||
                        catName.includes("COMMED");

                    if (isExcludedGroupName || isExcludedCatName) {
                        isExcluded = true;
                    }
                }
            });
        }

        if (isExcluded) return;
        window.openVoteModal(window.APP.current_question, true);

    }, 80);

    const allDone = window.APP.currentQuestions.length > 0 && window.APP.currentQuestions.every(q => q.state);
    if (allDone && !window.APP._quizCompletedHandled) {
        window.APP._quizCompletedHandled = true;
        setTimeout(() => {
            window.renderWeaknessStats();
            $('#stats-modal-card').css('display', 'flex').hide().fadeIn(250);
        }, 1500);
    }
};

// 6. ระบบระบุสีให้กับปุ่มตัวเลือก
window.checkAnswerUI = function (selectedVal, updateScore = true) {
    const correctVal = window.APP.current_question.answer;

    $('#choices').find('button').each(function () {
        // ใช้คำสั่ง .attr() แทน .data() ดึงข้อมูลแอตทริบิวต์โดยตรงเพื่อความเสถียรและหลีกเลี่ยงค่า undefined
        const val = $(this).attr('data-answer');
        if (val === correctVal) $(this).addClass('correct');
        if (val === selectedVal && val !== correctVal) $(this).addClass('wrong');
    });

    if (selectedVal === correctVal) {
        $('#feedback').addClass("correct").html(`ถูกต้อง! ${window.displayAnswerContent(correctVal)}`);
        if (updateScore) window.APP.score++;
    } else {
        $('#feedback').addClass("incorrect").html(`ผิด! คำตอบที่ถูกคือ: ${window.displayAnswerContent(correctVal)}`);
    }
    $('#score').text(`คะแนน: ${window.APP.score}/${window.APP.currentQuestions.length}`);
};

window.highlightAnswers = function () {
    $('#choices').find("button").each(function () {
        const buttonVal = $(this).attr('data-answer');
        if (buttonVal === window.APP.current_question.answer) {
            $(this).addClass("correct");
        } else if (buttonVal === window.APP.current_question.select) {
            $(this).addClass("wrong");
        }
    });
};

// 7. ตรรกะคัดแยกและจัดเรียงคำถาม
window.sortCurrentQuestions = function () {
    const answered = window.APP.currentQuestions.filter(q => q.state);
    const unanswered = window.APP.currentQuestions.filter(q => !q.state);

    const groupAndShuffle = (list) => {
        if (!window.APP.isRandomized) {
            return list.sort((a, b) => a._originalIndex - b._originalIndex);
        }

        const groups = [];
        const groupMap = new Map();

        list.forEach(q => {
            const match = q.problem.trim().match(/^(\d+)\./);
            if (match) {
                const baseNumber = match[1];
                if (!groupMap.has(baseNumber)) {
                    const newGroup = [];
                    groups.push(newGroup);
                    groupMap.set(baseNumber, newGroup);
                }
                groupMap.get(baseNumber).push(q);
            } else {
                groups.push([q]);
            }
        });

        groups.forEach(group => {
            if (group.length > 1) {
                group.sort((a, b) => {
                    return a.problem.localeCompare(b.problem, undefined, { numeric: true, sensitivity: 'base' });
                });
            }
        });

        for (let i = groups.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [groups[i], groups[j]] = [groups[j], groups[i]];
        }

        return groups.flat();
    };

    window.APP.currentQuestions = [...groupAndShuffle(answered), ...groupAndShuffle(unanswered)];
};

// 7.1 การสุ่มข้อแบบจำกัดจำนวนต่อหมวด (SSOT = window.APP.categoryLimits)

// สลับลำดับ array แบบ Fisher-Yates (in-place)
window.fisherYates = function (arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
};

// คำถามทั้งหมดของหมวดหนึ่ง — ต้องนับแบบเดียวกับ badge ใน renderAccordionUI
window.getCategoryPool = function (catId) {
    return window.APP.allQuestions.filter(q => {
        if (!q.category) return false;
        const cats = Array.isArray(q.category) ? q.category : [q.category];
        return cats.includes(catId);
    });
};

// อ่านลิมิตของหมวดจาก SSOT — ไม่มี/ไม่ถูกต้อง = เอาทั้งหมด, และไม่เกินจำนวนที่มีจริง
// รองรับทั้ง fixed number ("10") และ percentage ("50%") — % คำนวณจาก poolSize แล้ว clamp 1..poolSize
window.getCategoryLimit = function (catId, poolSize) {
    const raw = (window.APP.categoryLimits || {})[catId];
    if (raw == null) return poolSize;
    const s = String(raw).trim();
    if (s.endsWith('%')) {
        const pct = parseFloat(s);
        if (pct > 0 && pct <= 100) return Math.max(1, Math.min(poolSize, Math.round(poolSize * pct / 100)));
        return poolSize;
    }
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 1) return poolSize;
    return Math.min(n, poolSize);
};

// ลำดับสุ่มของแต่ละหมวดถูกจำไว้ตลอด session — กันไม่ให้ข้อที่ทำไปแล้วหายตอนติ๊กหมวดอื่นเพิ่ม
// (เพิ่มลิมิต = ต่อท้ายข้อใหม่, ลดลิมิต = ตัดท้ายทิ้ง, ข้อที่ sync เข้ามาใหม่ถูกสุ่มต่อท้าย)
window.getSampledCategoryOrder = function (catId, pool) {
    if (!window._catSampleOrder) window._catSampleOrder = {};

    const byId = new Map(pool.map(q => [q.questionId, q]));
    const kept = (window._catSampleOrder[catId] || []).filter(id => byId.has(id));
    const keptSet = new Set(kept);
    const fresh = window.fisherYates(
        pool.filter(q => !keptSet.has(q.questionId)).map(q => q.questionId)
    );

    const order = kept.concat(fresh);
    window._catSampleOrder[catId] = order;
    return order.map(id => byId.get(id));
};

// 8. การกรองและเปลี่ยนชุดข้อสอบ (Modified to support both categories and dynamic attribute filters)
window.updateQuestionSet = function (shouldSort = true, shouldShow = true) {
    window.APP._quizCompletedHandled = false;

    const previouslyAnswered = {};
    window.APP.currentQuestions.forEach(q => {
        if (q.state) {
            previouslyAnswered[q.questionId] = {
                select: q.select,
                state: q.state,
                attemptCount: q.attemptCount,
                failCount: q.failCount
            };
        }
    });

    window.APP.currentQuestions = [];

    if (window.APP.filterMode === "category") {
        // กรองแบบ Accordion Category ปกติ
        const selectedCategoryIds = $('input[type="checkbox"][name="category"]:checked').map(function () {
            return this.value;
        }).get();

        if (selectedCategoryIds.length === 0) {
            window.APP.currentQuestions = window.APP.allQuestions.map(q => ({
                ...q,
                attemptCount: 0,
                failCount: 0
            }));
        } else {
            // สุ่มทีละหมวดตามลิมิตของหมวดนั้น แล้วรวมกันโดยตัดข้อซ้ำ (ข้อเดียวอยู่ได้หลายหมวด)
            const picked = [];
            const seenIds = new Set();

            selectedCategoryIds.forEach(catId => {
                const pool = window.getCategoryPool(catId);
                if (pool.length === 0) return;

                const limit = window.getCategoryLimit(catId, pool.length);
                window.getSampledCategoryOrder(catId, pool).slice(0, limit).forEach(q => {
                    if (seenIds.has(q.questionId)) return;
                    seenIds.add(q.questionId);
                    picked.push({
                        ...q,
                        attemptCount: 0,
                        failCount: 0
                    });
                });
            });

            // สุ่มรวมรอบสุดท้ายเฉพาะตอนที่จะจัดเรียงใหม่อยู่แล้ว — path ที่ shouldSort=false
            // (กู้คืน session / import) ต้องคงลำดับเดิมไว้ให้ผู้เรียกจัดการเอง
            if (shouldSort && window.APP.isRandomized) window.fisherYates(picked);

            window.APP.currentQuestions = picked;
        }
    } else {
        // กรองแบบคุณสมบัติละเอียด (Year / ExamGroup / SubGroupSuffix / Topic)
        const selectedYears = $('input[type="checkbox"][name="filter-year"]:checked').map(function () { return this.value; }).get();
        const selectedGroups = $('input[type="checkbox"][name="filter-examgroup"]:checked').map(function () { return this.value; }).get();
        const selectedSuffixes = $('input[type="checkbox"][name="filter-suffix"]:checked').map(function () { return this.value; }).get();
        const selectedTopics = $('input[type="checkbox"][name="filter-topic"]:checked').map(function () { return this.value; }).get();

        const totalSelectedCount = selectedYears.length + selectedGroups.length + selectedSuffixes.length + selectedTopics.length;

        if (totalSelectedCount === 0) {
            window.APP.currentQuestions = window.APP.allQuestions.map(q => ({
                ...q,
                attemptCount: 0,
                failCount: 0
            }));
        } else {
            window.APP.currentQuestions = window.APP.allQuestions.filter(q => {
                const meta = window.parseQuestionMetadata(q);

                const matchYear = selectedYears.length === 0 || selectedYears.includes(meta.year);
                const matchGroup = selectedGroups.length === 0 || selectedGroups.includes(meta.examGroup);
                const matchSuffix = selectedSuffixes.length === 0 || selectedSuffixes.includes(meta.suffix);
                const matchTopic = selectedTopics.length === 0 || selectedTopics.includes(meta.topic);

                return matchYear && matchGroup && matchSuffix && matchTopic;
            }).map(q => ({
                ...q,
                attemptCount: 0,
                failCount: 0
            }));
        }
    }

    window.APP.score = 0;
    window.APP.currentQuestions.forEach(q => {
        if (previouslyAnswered[q.questionId]) {
            const prev = previouslyAnswered[q.questionId];
            q.select = prev.select;
            q.state = prev.state;
            q.attemptCount = prev.attemptCount;
            q.failCount = prev.failCount;
            if (q.state && q.select === q.answer) window.APP.score++;
        } else {
            q.state = false;
            q.select = "";
        }
    });

    if (shouldSort) window.sortCurrentQuestions();

    $('#score').text(`${window.APP.score}/${window.APP.currentQuestions.length}`);
    window.APP.questionIndex = 0;

    if (window.APP.currentQuestions.length > 0) {
        $('#image-container-div').hide();
        if (shouldShow) window.showQuestion(false);
    } else {
        $('#question').html("ไม่พบข้อสอบในเงื่อนไขการกรองที่เลือก");
        $('#choices').empty();
        $('#questionIndex').text("0/0");
        $('#btn-copy-question-ai').hide();
    }

    if (window.APP.currentQuestions.length > 0) {
        window.preloadQuizImages(window.APP.currentQuestions);
    }

    window.updateSelectedCategoryStatus();
    window.saveProgressToCache();
};

