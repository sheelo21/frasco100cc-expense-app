
(function () {
  "use strict";

  var STORAGE_KEY = "expenseMemo:v1";
  var DEFAULT_PRESETS = ["新幹線代", "タクシー代", "宿泊費", "航空券代", "駐車場代", "会議費", "郵送費"];
  var DEFAULT_DEPT_PRESETS = ["東京営業", "顧客対応", "パーソナル", "総務", "経営管理"];

  var state = loadState();

  function loadState() {
    var fallback = {
      items: [], archive: [],
      presets: DEFAULT_PRESETS.slice(),
      deptPresets: DEFAULT_DEPT_PRESETS.slice(),
      editingId: null, draftItemId: uid()
    };
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return {
        items: Array.isArray(parsed.items) ? parsed.items : [],
        archive: Array.isArray(parsed.archive) ? parsed.archive : [],
        presets: Array.isArray(parsed.presets) && parsed.presets.length ? parsed.presets : DEFAULT_PRESETS.slice(),
        deptPresets: Array.isArray(parsed.deptPresets) && parsed.deptPresets.length ? parsed.deptPresets : DEFAULT_DEPT_PRESETS.slice(),
        editingId: null,
        draftItemId: uid()
      };
    } catch (e) {
      return fallback;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        items: state.items,
        archive: state.archive,
        presets: state.presets,
        deptPresets: state.deptPresets
      }));
    } catch (e) {
      /* storage unavailable; app still works in-memory for this session */
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function isoToDisplay(iso) {
    var p = iso.split("-");
    if (p.length !== 3) return iso;
    return p[0] + "/" + Number(p[1]) + "/" + Number(p[2]);
  }

  function formatYen(n) {
    return Number(n).toLocaleString("ja-JP") + "円";
  }

  function formatAmountInput(raw) {
    var digits = String(raw).replace(/[^0-9]/g, "");
    digits = digits.replace(/^0+(?=\d)/, "");
    if (!digits) return "";
    return Number(digits).toLocaleString("ja-JP");
  }

  function amountValue(raw) {
    var digits = String(raw).replace(/[^0-9]/g, "");
    return digits ? parseInt(digits, 10) : 0;
  }

  function isPdfFile(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  }

  // ==== Attachment storage (IndexedDB; photos/PDFs never touch localStorage) ====
  var ATTACH_DB_NAME = "expenseMemoFiles";
  var ATTACH_STORE = "attachments";
  var attachDbPromise = null;
  var attachCountCache = {};

  function openAttachDB() {
    if (attachDbPromise) return attachDbPromise;
    attachDbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("indexedDB unavailable")); return; }
      var req = indexedDB.open(ATTACH_DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(ATTACH_STORE)) {
          var store = db.createObjectStore(ATTACH_STORE, { keyPath: "id" });
          store.createIndex("itemId", "itemId", { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return attachDbPromise;
  }

  function attachAdd(itemId, file) {
    return openAttachDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var record = {
          id: uid(),
          itemId: itemId,
          filename: file.name || (isPdfFile(file) ? "receipt.pdf" : "receipt.jpg"),
          mime: file.type || "",
          blob: file,
          createdAt: Date.now()
        };
        var tx = db.transaction(ATTACH_STORE, "readwrite");
        tx.objectStore(ATTACH_STORE).add(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function attachListForItem(itemId) {
    return openAttachDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ATTACH_STORE, "readonly");
        var idx = tx.objectStore(ATTACH_STORE).index("itemId");
        var req = idx.getAll(itemId);
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function attachDelete(id) {
    return openAttachDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ATTACH_STORE, "readwrite");
        tx.objectStore(ATTACH_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function attachDeleteAllForItem(itemId) {
    return attachListForItem(itemId).then(function (list) {
      return Promise.all(list.map(function (r) { return attachDelete(r.id); }));
    });
  }

  function attachAllRecordsMeta() {
    return openAttachDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ATTACH_STORE, "readonly");
        var req = tx.objectStore(ATTACH_STORE).getAll();
        req.onsuccess = function () {
          resolve((req.result || []).map(function (r) { return { id: r.id, itemId: r.itemId }; }));
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function refreshAttachCountCache() {
    return attachAllRecordsMeta().then(function (list) {
      var counts = {};
      list.forEach(function (r) { counts[r.itemId] = (counts[r.itemId] || 0) + 1; });
      attachCountCache = counts;
      return counts;
    }).catch(function () { return attachCountCache; });
  }

  function cleanupOrphanAttachments() {
    var knownIds = {};
    state.items.forEach(function (it) { knownIds[it.id] = true; });
    state.archive.forEach(function (b) { b.items.forEach(function (it) { knownIds[it.id] = true; }); });
    if (state.draftItemId) knownIds[state.draftItemId] = true;
    return attachAllRecordsMeta().then(function (list) {
      var toDelete = list.filter(function (r) { return !knownIds[r.itemId]; });
      return Promise.all(toDelete.map(function (r) { return attachDelete(r.id); }));
    }).then(refreshAttachCountCache).catch(function () {});
  }

  // ==== OCR engine ====
  // Runs entirely client-side (Tesseract.js + a bundled Japanese model, embedded further
  // below as OCR_ASSETS). No image or file ever leaves this browser tab. If the engine
  // can't start (unsupported browser, restrictive environment), every OCR call rejects and
  // the UI falls back to a friendly "read manually" message — attachments and the rest of
  // the app keep working either way.
  var ocrState = { status: "idle", worker: null, error: null, promise: null };

  function b64ToBytes(b64) {
    var chars = atob(b64);
    var bytes = new Uint8Array(chars.length);
    for (var i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
    return bytes;
  }
  function b64ToText(b64) { return atob(b64); }

  function seedOcrLangCache(key, value) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("indexedDB unavailable")); return; }
      var req = indexedDB.open("keyval-store");
      req.onupgradeneeded = function () { req.result.createObjectStore("keyval"); };
      req.onsuccess = function () {
        var db = req.result;
        var tx = db.transaction("keyval", "readwrite");
        tx.objectStore("keyval").put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(message || "timeout"));
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function ensureOcrReady() {
    if (ocrState.status === "ready") return Promise.resolve(ocrState.worker);
    if (ocrState.status === "unavailable") return Promise.reject(ocrState.error || new Error("OCR unavailable"));
    if (ocrState.promise) return ocrState.promise;

    ocrState.status = "loading";
    var buildPromise = Promise.resolve().then(function () {
      if (typeof Tesseract === "undefined" || typeof OCR_ASSETS === "undefined") {
        throw new Error("OCR assets not loaded");
      }
      var workerScriptBlob = new Blob([b64ToText(OCR_ASSETS.workerB64)], { type: "application/javascript" });
      var workerScriptBlobURL = URL.createObjectURL(workerScriptBlob);
      var coreJsText = b64ToText(OCR_ASSETS.coreB64);
      var composedSource = coreJsText + "\n;importScripts(" + JSON.stringify(workerScriptBlobURL) + ");";
      var composedBlob = new Blob([composedSource], { type: "application/javascript" });
      var composedBlobURL = URL.createObjectURL(composedBlob);
      var jpnData = b64ToBytes(OCR_ASSETS.jpnB64);

      return seedOcrLangCache("./jpn.traineddata", jpnData).then(function () {
        return Tesseract.createWorker("jpn", 1, {
          workerPath: composedBlobURL,
          workerBlobURL: false
        });
      });
    });

    // Some CSP/browser restrictions cause WASM compilation to abort internally without ever
    // resolving or rejecting the worker promise. A hard timeout guarantees we still fall back
    // to manual entry instead of leaving the "読み取り中" state stuck forever.
    ocrState.promise = withTimeout(buildPromise, 20000, "OCR initialization timed out").then(function (worker) {
      ocrState.status = "ready";
      ocrState.worker = worker;
      return worker;
    }).catch(function (e) {
      ocrState.status = "unavailable";
      ocrState.error = e;
      throw e;
    });

    return ocrState.promise;
  }

  function fileToDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  // ==== PDF rendering (client-side, via bundled pdf.js; PDFJS_ASSETS is defined earlier
  // in this file). Renders a PDF's first page to an image so the same OCR pipeline used
  // for photos can read it. Only the first page is read — most receipts are one page. ====
  var pdfLibState = { status: "idle", lib: null, error: null, promise: null };

  function ensurePdfLibReady() {
    if (pdfLibState.status === "ready") return Promise.resolve(pdfLibState.lib);
    if (pdfLibState.status === "unavailable") return Promise.reject(pdfLibState.error || new Error("PDF engine unavailable"));
    if (pdfLibState.promise) return pdfLibState.promise;

    pdfLibState.status = "loading";
    var buildPromise = Promise.resolve().then(function () {
      if (typeof PDFJS_ASSETS === "undefined") throw new Error("PDF assets not loaded");
      var libBlob = new Blob([b64ToText(PDFJS_ASSETS.libB64)], { type: "text/javascript" });
      var libUrl = URL.createObjectURL(libBlob);
      return import(libUrl).then(function (mod) {
        var workerBlob = new Blob([b64ToText(PDFJS_ASSETS.workerB64)], { type: "text/javascript" });
        var workerUrl = URL.createObjectURL(workerBlob);
        mod.GlobalWorkerOptions.workerSrc = workerUrl;
        return mod;
      });
    });

    pdfLibState.promise = withTimeout(buildPromise, 20000, "PDF engine load timed out").then(function (lib) {
      pdfLibState.status = "ready";
      pdfLibState.lib = lib;
      return lib;
    }).catch(function (e) {
      pdfLibState.status = "unavailable";
      pdfLibState.error = e;
      throw e;
    });

    return pdfLibState.promise;
  }

  function renderPdfFirstPageToDataURL(file) {
    return ensurePdfLibReady().then(function (pdfjsLib) {
      return file.arrayBuffer().then(function (buf) {
        return withTimeout(pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise, 20000, "PDF loading timed out");
      }).then(function (pdf) {
        return pdf.getPage(1);
      }).then(function (page) {
        var viewport = page.getViewport({ scale: 2.0 });
        var canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        var ctx = canvas.getContext("2d");
        return withTimeout(page.render({ canvasContext: ctx, viewport: viewport }).promise, 20000, "PDF rendering timed out").then(function () {
          return canvas.toDataURL("image/png");
        });
      });
    });
  }

  function runOcrOnFile(file) {
    var isPdf = isPdfFile(file);
    return ensureOcrReady().then(function (worker) {
      var dataUrlPromise = isPdf ? renderPdfFirstPageToDataURL(file) : fileToDataURL(file);
      return dataUrlPromise.then(function (dataUrl) {
        return withTimeout(worker.recognize(dataUrl), 30000, "OCR recognition timed out");
      });
    }).then(function (result) {
      return result.data.text || "";
    });
  }

  function extractDateFromText(text) {
    var re = /(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?/;
    var m = re.exec(text);
    if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function parseAmountToken(tok) {
    // OCR sometimes reads the thousands comma as a period; treat either as a separator
    var cleaned = tok.replace(/[^\d]/g, "");
    if (!cleaned) return null;
    var n = parseInt(cleaned, 10);
    return isNaN(n) ? null : n;
  }

  function extractAmountFromText(text) {
    var candidates = [];
    var lines = text.split("\n");
    var re = /([0-9]{1,3}(?:[,.][0-9]{3})+|[0-9]+)\s*円/g;
    lines.forEach(function (line) {
      if (line.indexOf("円") === -1) return;
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(line))) {
        var val = parseAmountToken(m[1]);
        if (val && val > 0 && val < 10000000) candidates.push({ value: val, line: line });
      }
    });
    if (!candidates.length) return null;

    var totalMatch = candidates.filter(function (c) { return c.line.indexOf("合計") !== -1; });
    if (totalMatch.length) return totalMatch[totalMatch.length - 1].value;

    var subtotalMatch = candidates.filter(function (c) { return c.line.indexOf("小計") !== -1; });
    if (subtotalMatch.length) return subtotalMatch[subtotalMatch.length - 1].value;

    var max = candidates[0].value;
    candidates.forEach(function (c) { if (c.value > max) max = c.value; });
    return max;
  }

  function extractDeptFromText(text, deptNames) {
    for (var i = 0; i < deptNames.length; i++) {
      if (deptNames[i] && text.indexOf(deptNames[i]) !== -1) return deptNames[i];
    }
    return null;
  }

  // ---- elements ----
  var els = {
    tabBtns: document.querySelectorAll(".tab-btn"),
    views: { main: document.getElementById("view-main"), archive: document.getElementById("view-archive") },
    form: document.getElementById("entry-form"),
    formTitle: document.getElementById("form-title"),
    date: document.getElementById("f-date"),
    btnToday: document.getElementById("btn-today"),
    dept: document.getElementById("f-dept"),
    deptPresetRow: document.getElementById("dept-preset-row"),
    deptPresetToggle: document.getElementById("dept-preset-toggle"),
    deptPresetManage: document.getElementById("dept-preset-manage"),
    deptPresetNew: document.getElementById("dept-preset-new"),
    deptPresetAdd: document.getElementById("dept-preset-add"),
    desc: document.getElementById("f-desc"),
    descQuickSelect: document.getElementById("desc-quick-select"),
    amount: document.getElementById("f-amount"),
    presetRow: document.getElementById("preset-row"),
    presetToggle: document.getElementById("preset-toggle"),
    presetManage: document.getElementById("preset-manage"),
    presetNew: document.getElementById("preset-new"),
    presetAdd: document.getElementById("preset-add"),
    btnSubmit: document.getElementById("btn-submit"),
    btnCancelEdit: document.getElementById("btn-cancel-edit"),
    tbody: document.getElementById("expense-tbody"),
    emptyNote: document.getElementById("empty-note"),
    table: document.getElementById("expense-table"),
    countHint: document.getElementById("count-hint"),
    totalValue: document.getElementById("total-value"),
    outputText: document.getElementById("output-text"),
    btnCopy: document.getElementById("btn-copy"),
    copyStatus: document.getElementById("copy-status"),
    btnClear: document.getElementById("btn-clear"),
    clearModal: document.getElementById("clear-modal"),
    archiveLabel: document.getElementById("archive-label"),
    clearCancel: document.getElementById("clear-cancel"),
    clearConfirm: document.getElementById("clear-confirm"),
    archiveList: document.getElementById("archive-list"),
    archiveEmpty: document.getElementById("archive-empty"),
    btnAttachPhoto: document.getElementById("btn-attach-photo"),
    btnAttachFile: document.getElementById("btn-attach-file"),
    attachInputCamera: document.getElementById("attach-input-camera"),
    attachInputFile: document.getElementById("attach-input-file"),
    attachList: document.getElementById("attach-list"),
    ocrNote: document.getElementById("ocr-note"),
    ocrRawToggle: document.getElementById("ocr-raw-toggle"),
    ocrRaw: document.getElementById("ocr-raw"),
    lightboxModal: document.getElementById("lightbox-modal"),
    lightboxTitle: document.getElementById("lightbox-title"),
    lightboxContent: document.getElementById("lightbox-content"),
    lightboxClose: document.getElementById("lightbox-close")
  };

  function activeItemId() {
    return state.editingId || state.draftItemId;
  }

  // ---- tabs ----
  els.tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      els.tabBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      Object.keys(els.views).forEach(function (k) { els.views[k].classList.remove("active"); });
      els.views[btn.dataset.view].classList.add("active");
    });
  });

  // ---- department select ----
  // The dropdown always offers the managed preset list (state.deptPresets), plus any
  // department name already used in saved data that isn't in that list (so editing old
  // entries never silently loses/corrupts their department, even after the preset list changes).
  function deptOptionsList() {
    var counts = {};
    state.items.concat(state.archive.reduce(function (acc, b) { return acc.concat(b.items); }, [])).forEach(function (it) {
      counts[it.department] = (counts[it.department] || 0) + 1;
    });
    var extra = Object.keys(counts)
      .filter(function (n) { return n && state.deptPresets.indexOf(n) === -1; })
      .sort(function (a, b) { return counts[b] - counts[a]; });
    return state.deptPresets.concat(extra);
  }

  function renderDeptSelect() {
    var current = els.dept.value;
    var options = deptOptionsList();
    var html = '<option value="" disabled' + (current ? "" : " selected") + '>選択してください</option>';
    html += options.map(function (n) {
      return '<option value="' + escapeHtml(n) + '"' + (n === current ? " selected" : "") + '>' + escapeHtml(n) + '</option>';
    }).join("");
    els.dept.innerHTML = html;
    if (current && options.indexOf(current) !== -1) els.dept.value = current;
  }

  function renderDeptPresetEditor() {
    var editing = els.deptPresetManage.style.display !== "none";
    els.deptPresetRow.style.display = editing ? "" : "none";
    els.deptPresetRow.innerHTML = "";
    if (!editing) return;
    state.deptPresets.forEach(function (p, idx) {
      var wrap = document.createElement("span");
      wrap.className = "chip-edit";
      var txt = document.createElement("span");
      txt.textContent = p;
      var rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "×";
      rm.title = "削除";
      rm.addEventListener("click", function () {
        state.deptPresets.splice(idx, 1);
        saveState();
        renderDeptPresetEditor();
        renderDeptSelect();
      });
      wrap.appendChild(txt);
      wrap.appendChild(rm);
      els.deptPresetRow.appendChild(wrap);
    });
  }

  els.deptPresetToggle.addEventListener("click", function () {
    var showing = els.deptPresetManage.style.display !== "none";
    els.deptPresetManage.style.display = showing ? "none" : "flex";
    els.deptPresetToggle.textContent = showing ? "部署の選択肢を編集" : "編集を終える";
    renderDeptPresetEditor();
  });

  els.deptPresetAdd.addEventListener("click", addDeptPreset);
  els.deptPresetNew.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); addDeptPreset(); }
  });

  function addDeptPreset() {
    var v = els.deptPresetNew.value.trim();
    if (!v) return;
    if (state.deptPresets.indexOf(v) === -1) state.deptPresets.push(v);
    els.deptPresetNew.value = "";
    saveState();
    renderDeptPresetEditor();
    renderDeptSelect();
  }

  // ---- description presets (quick-insert dropdown + editable candidate list) ----
  function renderPresets() {
    var editing = els.presetManage.style.display !== "none";
    els.presetRow.style.display = editing ? "" : "none";
    els.presetRow.innerHTML = "";

    if (editing) {
      state.presets.forEach(function (p, idx) {
        var wrap = document.createElement("span");
        wrap.className = "chip-edit";
        var txt = document.createElement("span");
        txt.textContent = p;
        var rm = document.createElement("button");
        rm.type = "button";
        rm.textContent = "×";
        rm.title = "削除";
        rm.addEventListener("click", function () {
          state.presets.splice(idx, 1);
          saveState();
          renderPresets();
        });
        wrap.appendChild(txt);
        wrap.appendChild(rm);
        els.presetRow.appendChild(wrap);
      });
    }

    els.descQuickSelect.innerHTML = '<option value="">候補から選んで入力（続けて自由に書き足せます）</option>' +
      state.presets.map(function (p) { return '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>'; }).join("");
  }

  els.descQuickSelect.addEventListener("change", function () {
    var v = els.descQuickSelect.value;
    if (v) {
      els.desc.value = v;
      els.desc.focus();
    }
    els.descQuickSelect.selectedIndex = 0;
  });

  els.presetToggle.addEventListener("click", function () {
    var showing = els.presetManage.style.display !== "none";
    els.presetManage.style.display = showing ? "none" : "flex";
    els.presetToggle.textContent = showing ? "よく使う候補を編集" : "編集を終える";
    renderPresets();
  });

  els.presetAdd.addEventListener("click", addPreset);
  els.presetNew.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); addPreset(); }
  });

  function addPreset() {
    var v = els.presetNew.value.trim();
    if (!v) return;
    if (state.presets.indexOf(v) === -1) state.presets.push(v);
    els.presetNew.value = "";
    saveState();
    renderPresets();
  }

  // ---- amount input formatting ----
  els.amount.addEventListener("input", function () {
    var cursorFromEnd = els.amount.value.length - els.amount.selectionStart;
    els.amount.value = formatAmountInput(els.amount.value);
    var pos = Math.max(0, els.amount.value.length - cursorFromEnd);
    els.amount.setSelectionRange(pos, pos);
  });

  els.btnToday.addEventListener("click", function () {
    els.date.value = todayISO();
  });

  // ---- attachments (photos / PDFs) + OCR ----
  function showOcrNote(kind, text) {
    els.ocrNote.textContent = text;
    els.ocrNote.className = "ocr-note show " + kind;
  }
  function hideOcrNote() {
    els.ocrNote.className = "ocr-note";
    els.ocrNote.textContent = "";
  }
  function showOcrRaw(text) {
    if (!text) { els.ocrRawToggle.style.display = "none"; els.ocrRaw.className = "ocr-raw"; return; }
    els.ocrRawToggle.style.display = "";
    els.ocrRaw.textContent = text;
  }
  els.ocrRawToggle.addEventListener("click", function () {
    var showing = els.ocrRaw.classList.contains("show");
    els.ocrRaw.className = showing ? "ocr-raw" : "ocr-raw show";
    els.ocrRawToggle.textContent = showing ? "読み取った文字を見る" : "読み取った文字を隠す";
  });

  function renderAttachList() {
    var itemId = activeItemId();
    els.attachList.innerHTML = "";
    if (!itemId) return;
    attachListForItem(itemId).then(function (list) {
      list.sort(function (a, b) { return a.createdAt - b.createdAt; });
      els.attachList.innerHTML = "";
      list.forEach(function (rec) {
        els.attachList.appendChild(buildAttachChip(rec));
      });
    }).catch(function () { /* attachments unavailable in this browser; form still works */ });
  }

  function buildAttachChip(rec) {
    var isPdf = rec.mime === "application/pdf" || /\.pdf$/i.test(rec.filename || "");
    var chip = document.createElement("div");
    chip.className = "attach-chip";

    var thumb;
    var objectUrl = null;
    if (isPdf) {
      thumb = document.createElement("div");
      thumb.className = "attach-thumb pdf";
      thumb.textContent = "PDF";
    } else {
      thumb = document.createElement("img");
      thumb.className = "attach-thumb";
      objectUrl = URL.createObjectURL(rec.blob);
      thumb.src = objectUrl;
    }
    thumb.addEventListener("click", function () { openLightboxForRecord(rec); });
    chip.appendChild(thumb);

    var meta = document.createElement("div");
    meta.className = "attach-meta";
    var name = document.createElement("span");
    name.className = "attach-name";
    name.textContent = rec.filename || (isPdf ? "PDF" : "写真");
    meta.appendChild(name);

    var actions = document.createElement("div");
    actions.className = "attach-actions";

    var ocrBtn = document.createElement("button");
    ocrBtn.type = "button";
    ocrBtn.textContent = "読み取る";
    ocrBtn.addEventListener("click", function () { runOcrForRecord(rec, ocrBtn); });
    actions.appendChild(ocrBtn);

    var viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.textContent = "表示";
    viewBtn.addEventListener("click", function () { openLightboxForRecord(rec); });
    actions.appendChild(viewBtn);

    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", function () {
      if (!window.confirm("この添付を削除しますか？")) return;
      attachDelete(rec.id).then(function () {
        return refreshAttachCountCache();
      }).then(function () {
        renderAttachList();
        renderTable();
        renderArchive();
      });
    });
    actions.appendChild(delBtn);

    meta.appendChild(actions);
    chip.appendChild(meta);
    return chip;
  }

  function runOcrForRecord(rec, triggerBtn) {
    hideOcrNote();
    showOcrRaw("");
    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "読み取り中…"; }
    showOcrNote("info", "読み取り中です（この端末内で処理しており、外部には送信されません）…");

    runOcrOnFile(rec.blob).then(function (text) {
      var foundDate = extractDateFromText(text);
      var foundAmount = extractAmountFromText(text);
      var knownDepts = deptOptionsList();
      var foundDept = extractDeptFromText(text, knownDepts);
      var knownDescs = state.presets;
      var foundDesc = extractDeptFromText(text, knownDescs);

      var filled = [];
      if (foundDate) { els.date.value = foundDate; filled.push("日付：" + isoToDisplay(foundDate)); }
      if (foundAmount) { els.amount.value = formatAmountInput(String(foundAmount)); filled.push("金額：" + formatYen(foundAmount)); }
      if (foundDept && !els.dept.value.trim()) { els.dept.value = foundDept; filled.push("部署：" + foundDept); }
      if (foundDesc && !els.desc.value.trim()) { els.desc.value = foundDesc; filled.push("摘要：" + foundDesc); }

      if (filled.length) {
        showOcrNote("info", "読み取り候補を反映しました（" + filled.join("、") + "）。内容を必ずご確認ください。");
      } else {
        showOcrNote("warn", "日付・金額を自動では読み取れませんでした。お手数ですが手入力をお願いします。");
      }
      showOcrRaw(text.trim());
    }).catch(function (e) {
      showOcrNote("warn", "この端末・ブラウザでは自動読み取りをご利用いただけません。お手数ですが手入力をお願いします。");
    }).then(function () {
      if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = "読み取る"; }
    });
  }

  function handleFilesSelected(fileList) {
    var itemId = activeItemId();
    if (!itemId || !fileList || !fileList.length) return;
    var files = Array.prototype.slice.call(fileList);
    Promise.all(files.map(function (f) { return attachAdd(itemId, f); })).then(function (added) {
      return refreshAttachCountCache().then(function () { return added; });
    }).then(function (added) {
      renderAttachList();
      renderTable();
      renderArchive();
      // auto-trigger OCR for the first newly added attachment (photo or PDF), if any
      if (added.length) {
        // slight delay so the chip is visible before the "reading" state appears
        setTimeout(function () { runOcrForRecord(added[0], null); }, 50);
      }
    }).catch(function () {
      window.alert("添付の保存に失敗しました。この端末・ブラウザではファイル添付をご利用いただけない可能性があります。");
    });
  }

  els.btnAttachPhoto.addEventListener("click", function () { els.attachInputCamera.click(); });
  els.btnAttachFile.addEventListener("click", function () { els.attachInputFile.click(); });
  els.attachInputCamera.addEventListener("change", function () {
    handleFilesSelected(this.files);
    this.value = "";
  });
  els.attachInputFile.addEventListener("change", function () {
    handleFilesSelected(this.files);
    this.value = "";
  });

  // ---- lightbox ----
  var lightboxObjectUrls = [];
  function closeLightbox() {
    els.lightboxModal.close();
    lightboxObjectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    lightboxObjectUrls = [];
    els.lightboxContent.innerHTML = "";
  }
  els.lightboxClose.addEventListener("click", closeLightbox);
  els.lightboxModal.addEventListener("cancel", function (e) { e.preventDefault(); closeLightbox(); });

  function appendAttachToLightbox(rec) {
    var isPdf = rec.mime === "application/pdf" || /\.pdf$/i.test(rec.filename || "");
    var url = URL.createObjectURL(rec.blob);
    lightboxObjectUrls.push(url);
    if (isPdf) {
      var wrap = document.createElement("div");
      wrap.className = "pdf-open-row";
      var link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "btn btn-ghost";
      link.textContent = "📄 " + (rec.filename || "PDF") + " を新しいタブで開く";
      wrap.appendChild(link);
      els.lightboxContent.appendChild(wrap);
    } else {
      var img = document.createElement("img");
      img.src = url;
      els.lightboxContent.appendChild(img);
    }
  }

  function openLightboxForRecord(rec) {
    els.lightboxContent.innerHTML = "";
    els.lightboxTitle.textContent = rec.filename || "添付";
    appendAttachToLightbox(rec);
    els.lightboxModal.showModal();
  }

  function openAttachGalleryForItems(items, title) {
    els.lightboxContent.innerHTML = "";
    els.lightboxTitle.textContent = title || "添付";
    Promise.all(items.map(function (it) { return attachListForItem(it.id); })).then(function (lists) {
      var all = [].concat.apply([], lists).sort(function (a, b) { return a.createdAt - b.createdAt; });
      els.lightboxContent.innerHTML = "";
      if (!all.length) {
        var p = document.createElement("p");
        p.textContent = "添付はありません。";
        els.lightboxContent.appendChild(p);
      } else {
        all.forEach(function (rec, idx) {
          if (idx > 0) els.lightboxContent.appendChild(document.createElement("hr"));
          appendAttachToLightbox(rec);
        });
      }
    });
    els.lightboxModal.showModal();
  }

  // ---- form submit (add / update) ----
  els.form.addEventListener("submit", function (e) {
    e.preventDefault();
    var date = els.date.value;
    var dept = els.dept.value.trim();
    var desc = els.desc.value.trim();
    var amount = amountValue(els.amount.value);

    if (!date || !dept || !desc || !amount) {
      window.alert("日付・部署・摘要・金額をすべて入力してください。");
      return;
    }

    if (state.editingId) {
      var item = state.items.find(function (it) { return it.id === state.editingId; });
      if (item) {
        item.date = date; item.department = dept; item.description = desc; item.amount = amount;
      }
      state.editingId = null;
    } else {
      state.items.push({ id: state.draftItemId, date: date, department: dept, description: desc, amount: amount });
    }

    saveState();
    resetForm();
    renderAll();
  });

  els.btnCancelEdit.addEventListener("click", function () {
    state.editingId = null;
    resetForm();
  });

  function resetForm() {
    els.form.reset();
    els.date.value = todayISO();
    els.dept.value = ""; // require an explicit department choice for every entry, don't carry the previous one over
    els.formTitle.textContent = "経費を入力";
    els.btnSubmit.textContent = "追加";
    els.btnCancelEdit.style.display = "none";
    state.draftItemId = uid();
    hideOcrNote();
    showOcrRaw("");
    renderAttachList();
  }

  function startEdit(id) {
    var item = state.items.find(function (it) { return it.id === id; });
    if (!item) return;
    state.editingId = id;
    els.date.value = item.date;
    els.dept.value = item.department;
    els.desc.value = item.description;
    els.amount.value = formatAmountInput(String(item.amount));
    els.formTitle.textContent = "経費を編集";
    els.btnSubmit.textContent = "更新";
    els.btnCancelEdit.style.display = "";
    hideOcrNote();
    showOcrRaw("");
    renderAttachList();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteItem(id) {
    if (!window.confirm("この行を削除しますか？（添付した写真・PDFも削除されます）")) return;
    state.items = state.items.filter(function (it) { return it.id !== id; });
    if (state.editingId === id) { state.editingId = null; resetForm(); }
    saveState();
    renderAll();
    attachDeleteAllForItem(id).then(refreshAttachCountCache).then(function () {
      renderTable();
      renderArchive();
    }).catch(function () {});
  }

  // ---- rendering: table ----
  function sortedItems(list) {
    return list.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  }

  function renderTable() {
    var items = sortedItems(state.items);
    els.tbody.innerHTML = "";
    els.table.style.display = items.length ? "" : "none";
    els.emptyNote.style.display = items.length ? "none" : "";
    els.countHint.textContent = items.length + "件・日付順";

    items.forEach(function (it) {
      var tr = document.createElement("tr");

      var tdDate = document.createElement("td");
      tdDate.textContent = isoToDisplay(it.date);
      tr.appendChild(tdDate);

      var tdDept = document.createElement("td");
      tdDept.textContent = it.department;
      tr.appendChild(tdDept);

      var tdDesc = document.createElement("td");
      tdDesc.textContent = it.description;
      var attachN = attachCountCache[it.id] || 0;
      if (attachN) {
        var badge = document.createElement("button");
        badge.type = "button";
        badge.className = "row-attach-badge";
        badge.textContent = "📎" + attachN;
        badge.title = "添付を見る";
        badge.addEventListener("click", function (e) {
          e.stopPropagation();
          openAttachGalleryForItems([it], isoToDisplay(it.date) + "　" + it.description);
        });
        tdDesc.appendChild(badge);
      }
      tr.appendChild(tdDesc);

      var tdAmt = document.createElement("td");
      tdAmt.className = "num";
      tdAmt.textContent = formatYen(it.amount);
      tr.appendChild(tdAmt);

      var tdAct = document.createElement("td");
      tdAct.className = "actions";
      var editBtn = document.createElement("button");
      editBtn.type = "button"; editBtn.className = "row-btn"; editBtn.textContent = "編集";
      editBtn.addEventListener("click", function () { startEdit(it.id); });
      var delBtn = document.createElement("button");
      delBtn.type = "button"; delBtn.className = "row-btn danger"; delBtn.textContent = "削除";
      delBtn.addEventListener("click", function () { deleteItem(it.id); });
      tdAct.appendChild(editBtn);
      tdAct.appendChild(delBtn);
      tr.appendChild(tdAct);

      els.tbody.appendChild(tr);
    });
  }

  function total(list) {
    return list.reduce(function (sum, it) { return sum + Number(it.amount || 0); }, 0);
  }

  function buildText(list) {
    var items = sortedItems(list);
    if (!items.length) return "";
    var blocks = items.map(function (it) {
      return "日付　：" + isoToDisplay(it.date) + "\n" +
             "部署　：" + it.department + "\n" +
             "摘要　：" + it.description + "\n" +
             "金額　：" + formatYen(it.amount);
    });
    return blocks.join("\n\n") + "\n\n合計　：" + formatYen(total(items));
  }

  function renderOutput() {
    els.totalValue.textContent = formatYen(total(state.items));
    els.outputText.value = buildText(state.items);
  }

  els.btnCopy.addEventListener("click", function () {
    var text = els.outputText.value;
    if (!text) return;
    var done = function () {
      els.copyStatus.classList.add("show");
      setTimeout(function () { els.copyStatus.classList.remove("show"); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  });

  function fallbackCopy(text, done) {
    try {
      els.outputText.focus();
      els.outputText.select();
      document.execCommand("copy");
      done();
    } catch (e) { /* clipboard unavailable */ }
  }

  // ---- clear -> archive ----
  els.btnClear.addEventListener("click", function () {
    if (!state.items.length) {
      window.alert("今回分の一覧が空です。");
      return;
    }
    var d = new Date();
    els.archiveLabel.value = d.getFullYear() + "年" + (d.getMonth() + 1) + "月";
    els.clearModal.showModal();
  });

  els.clearCancel.addEventListener("click", function () { els.clearModal.close(); });

  els.clearConfirm.addEventListener("click", function () {
    var label = els.archiveLabel.value.trim() || "提出分";
    state.archive.unshift({
      id: uid(),
      label: label,
      submittedAt: new Date().toISOString(),
      items: state.items.slice(),
      total: total(state.items),
      text: buildText(state.items)
    });
    state.items = [];
    saveState();
    els.clearModal.close();
    resetForm();
    renderAll();
  });

  // ---- archive view ----
  function renderArchive() {
    els.archiveList.innerHTML = "";
    els.archiveEmpty.style.display = state.archive.length ? "none" : "";

    state.archive.forEach(function (batch) {
      var det = document.createElement("details");
      det.className = "archive-item";

      var sum = document.createElement("summary");
      var left = document.createElement("span");
      left.className = "title";
      left.textContent = batch.label + "（" + batch.items.length + "件）";
      var right = document.createElement("span");
      right.className = "meta";
      right.textContent = formatYen(batch.total);
      sum.appendChild(left);
      sum.appendChild(right);
      det.appendChild(sum);

      var body = document.createElement("div");
      body.className = "body";

      var ta = document.createElement("textarea");
      ta.className = "output";
      ta.readOnly = true;
      ta.style.minHeight = "160px";
      ta.value = batch.text;
      body.appendChild(ta);

      var row = document.createElement("div");
      row.className = "copy-row";
      var copyBtn = document.createElement("button");
      copyBtn.type = "button"; copyBtn.className = "btn btn-ghost"; copyBtn.textContent = "テキストをコピー";
      var status = document.createElement("span");
      status.className = "copy-status"; status.textContent = "コピーしました";
      copyBtn.addEventListener("click", function () {
        var done = function () {
          status.classList.add("show");
          setTimeout(function () { status.classList.remove("show"); }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(batch.text).then(done).catch(function () { fallbackCopy(batch.text, done); });
        } else {
          fallbackCopy(batch.text, done);
        }
      });
      row.appendChild(copyBtn);
      row.appendChild(status);

      var attachN = batch.items.reduce(function (sum, it) { return sum + (attachCountCache[it.id] || 0); }, 0);
      if (attachN) {
        var viewAttachBtn = document.createElement("button");
        viewAttachBtn.type = "button"; viewAttachBtn.className = "btn btn-ghost"; viewAttachBtn.textContent = "📎 添付を見る（" + attachN + "）";
        viewAttachBtn.addEventListener("click", function () {
          openAttachGalleryForItems(batch.items, batch.label);
        });
        row.appendChild(viewAttachBtn);
      }
      body.appendChild(row);

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-ghost btn-block";
      delBtn.style.marginTop = "10px";
      delBtn.textContent = "この履歴を削除";
      delBtn.addEventListener("click", function () {
        if (!window.confirm("この提出履歴を削除しますか？添付した写真・PDFも削除され、元に戻せません。")) return;
        state.archive = state.archive.filter(function (b) { return b.id !== batch.id; });
        saveState();
        renderAll();
        Promise.all(batch.items.map(function (it) { return attachDeleteAllForItem(it.id); }))
          .then(refreshAttachCountCache).then(function () { renderTable(); renderArchive(); }).catch(function () {});
      });
      body.appendChild(delBtn);

      det.appendChild(body);
      els.archiveList.appendChild(det);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderAll() {
    renderDeptSelect();
    renderPresets();
    renderTable();
    renderOutput();
    renderArchive();
  }

  // ---- init ----
  els.date.value = todayISO();
  renderAll();
  renderAttachList();
  refreshAttachCountCache().then(function () {
    renderTable();
    renderArchive();
    return cleanupOrphanAttachments();
  }).then(function () {
    renderTable();
    renderArchive();
  }).catch(function () { /* IndexedDB unavailable: attachments feature quietly disabled */ });
})();
