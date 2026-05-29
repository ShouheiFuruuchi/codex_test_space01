const samplePdfFiles = [
  { name: "(加藤)2026年4月社販表.pdf", employee: "加藤", size: 51273 },
  { name: "(橋本)4月社販タグ表.pdf", employee: "橋本", size: 233184 },
  { name: "(河原)2026年4月社販タグ表.pdf", employee: "河原", size: 217295 },
  { name: "(渡辺)2026年4月社販タグ.pdf", employee: "渡辺", size: 237611 },
  { name: "(藤井)4月社販タグ.pdf", employee: "藤井", size: 37400 },
  { name: "(赤岩)2026年4月社販タグ表.pdf", employee: "赤岩", size: 212378 },
  { name: "(關)2026年4月タグ表.pdf", employee: "關", size: 48447 },
  { name: "（工藤）4月社販タグ表.pdf", employee: "工藤", size: 199010 },
  { name: "４月　猪又社販表.pdf", employee: "猪又", size: 214971 },
];

const sampleMaster = [
  { barcode: "1001234567890", name: "天竺Tシャツ（オフ）", price: 3900 },
  { barcode: "1001234567891", name: "デニムパンツ（ブルー）", price: 8900 },
  { barcode: "1001234567892", name: "リネンシャツ（ベージュ）", price: 6900 },
  { barcode: "1001234567893", name: "スカート（ブラック）", price: 7900 },
  { barcode: "1001234567894", name: "カーディガン（グレー）", price: 6800 },
  { barcode: "1001234567895", name: "ワンピース（ネイビー）", price: 9900 },
];

const sampleScans = `加藤,1001234567890,2
加藤,1001234567891,1
橋本,1001234567892,1
橋本,2999999999999,1
河原,1001234567893,1
渡辺,1001234567894,2
藤井,1001234567895,1
赤岩,2888888888888,2
關,1001234567890,1
工藤,1001234567891,1
猪又,2777777777777,1`;

const state = {
  pdfFiles: samplePdfFiles,
  selectedFiles: [],
  master: [],
  scans: [],
  matched: [],
  unmatched: [],
  selectedEmployee: "加藤",
  search: "",
  filter: "all",
  demoMode: false,
  isReading: false,
  readMessages: new Map(),
};

const els = {
  pdfFile: document.querySelector("#pdf-file"),
  masterFile: document.querySelector("#master-file"),
  pdfName: document.querySelector("#pdf-name"),
  masterName: document.querySelector("#master-name"),
  pdfCount: document.querySelector("#pdf-count"),
  fileCountLabel: document.querySelector("#file-count-label"),
  pdfTotalLabel: document.querySelector("#pdf-total-label"),
  pdfList: document.querySelector("#pdf-list"),
  scanCount: document.querySelector("#scan-count"),
  matchCount: document.querySelector("#match-count"),
  unmatchCount: document.querySelector("#unmatch-count"),
  readStatus: document.querySelector("#read-status"),
  masterStatus: document.querySelector("#master-status"),
  progressBar: document.querySelector("#progress-bar"),
  employeeRanking: document.querySelector("#employee-ranking"),
  employeeSelect: document.querySelector("#employee-select"),
  employeeSearch: document.querySelector("#employee-search"),
  reasonFilter: document.querySelector("#reason-filter"),
  employeeItems: document.querySelector("#employee-items"),
  employeeUnmatched: document.querySelector("#employee-unmatched"),
  employeeTotal: document.querySelector("#employee-total"),
  detailBody: document.querySelector("#detail-body"),
  employeeUnmatchedList: document.querySelector("#employee-unmatched-list"),
  unmatchedList: document.querySelector("#unmatched-list"),
  barcodeSearch: document.querySelector("#barcode-search"),
  summaryQty: document.querySelector("#summary-qty"),
  summaryUnmatched: document.querySelector("#summary-unmatched"),
  summaryTotal: document.querySelector("#summary-total"),
  exportSummary: document.querySelector("#export-summary"),
  exportDetail: document.querySelector("#export-detail"),
  barcodeInput: document.querySelector("#barcode-input"),
  toast: document.querySelector("#toast"),
};

function yen(value) {
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value);
}

function kb(size) {
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parseMaster(text) {
  const rows = parseCsv(text);
  const body = rows[0]?.some((cell) => /barcode|jan|商品コード|バーコード/i.test(cell)) ? rows.slice(1) : rows;
  return body
    .map((row) => ({
      barcode: normalizeBarcode(row[1]),
      name: row[2] || "",
      price: Number(String(row[18] || "").replace(/[^\d.-]/g, "")) || 0,
    }))
    .filter((item) => item.barcode && item.name && Number.isFinite(item.price));
}

async function readTextFile(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("shift_jis").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function parseScans(text) {
  return parseCsv(text)
    .map(([employee, barcode, quantity = "1", fileName = ""]) => ({
      employee,
      barcode: normalizeBarcode(barcode),
      quantity: Number(String(quantity).replace(/[^\d]/g, "")) || 1,
      fileName: fileName || state.pdfFiles.find((file) => file.employee === employee)?.name || "-",
    }))
    .filter((item) => item.employee && item.barcode);
}

function normalizeBarcode(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length === 14 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function employeeFromFileName(name) {
  const normalized = name.replace(/[（）]/g, (char) => (char === "（" ? "(" : ")"));
  const paren = normalized.match(/\(([^)]+)\)/);
  if (paren) return paren[1].trim();
  return (
    normalized
      .replace(/\d{4}年|\d+月|４月|社販|タグ|表|\.pdf/gi, "")
      .replace(/\s+/g, "")
      .trim() || "社員名未取得"
  );
}

function getEmployees() {
  return [...new Set([...state.pdfFiles.map((file) => file.employee), ...state.scans.map((scan) => scan.employee)])];
}

function employeeStats(employee) {
  const matched = state.matched.filter((item) => item.employee === employee);
  const unmatched = state.unmatched.filter((item) => item.employee === employee);
  return {
    employee,
    matchedQty: matched.reduce((sum, item) => sum + item.quantity, 0),
    unmatchedQty: unmatched.reduce((sum, item) => sum + item.quantity, 0),
    total: matched.reduce((sum, item) => sum + item.amount, 0),
    matched,
    unmatched,
  };
}

function runMatch() {
  const masterMap = new Map(state.master.map((item) => [item.barcode, item]));
  state.scans = parseScans(els.barcodeInput.value || sampleScans);
  state.matched = [];
  state.unmatched = [];

  state.scans.forEach((scan) => {
    const product = masterMap.get(scan.barcode);
    if (product) {
      state.matched.push({ ...scan, productName: product.name, price: product.price, amount: product.price * scan.quantity });
    } else {
      state.unmatched.push({ ...scan, reason: state.master.length ? "商品マスタに未登録" : "商品マスタ未読込" });
    }
  });

  const employees = getEmployees();
  if (!employees.includes(state.selectedEmployee)) state.selectedEmployee = employees[0] || "";
  render();
}

function render() {
  renderStatus();
  renderPdfFiles();
  renderEmployeeOptions();
  renderEmployeeSummary();
  renderInspector();
  renderUnmatched();
}

function renderStatus() {
  els.pdfCount.textContent = state.pdfFiles.length;
  els.fileCountLabel.textContent = state.pdfFiles.length;
  els.pdfTotalLabel.textContent = `${state.pdfFiles.length}件のPDF`;
  els.scanCount.textContent = state.scans.length;
  els.matchCount.textContent = state.matched.length;
  els.unmatchCount.textContent = state.unmatched.length;
  els.readStatus.textContent = state.isReading ? "読取中" : state.scans.length ? "読取済み" : "未実行";
  if (state.demoMode && state.scans.length) els.readStatus.textContent = "デモ読込";
  els.readStatus.className = state.scans.length ? "" : "pending";
  els.masterStatus.textContent = state.master.length ? "読込済み" : "未読込";
  els.masterStatus.className = state.master.length ? "" : "danger";
  const ratio = state.scans.length ? Math.round((state.matched.length / state.scans.length) * 100) : 0;
  els.progressBar.style.width = `${ratio}%`;
  els.pdfName.textContent = `選択済みPDF: ${state.pdfFiles.length}ファイル`;
  els.masterName.textContent = state.master.length ? `商品マスタ読込済み: ${state.master.length}件` : "商品マスタ未読込";
  els.exportSummary.disabled = !state.matched.length;
  els.exportDetail.disabled = !state.matched.length;
}

function renderPdfFiles() {
  els.pdfList.innerHTML = state.pdfFiles
    .map((file) => {
      const message = state.readMessages.get(file.name);
      const hasScan = state.scans.some((scan) => scan.fileName === file.name || scan.employee === file.employee);
      const label = message || (hasScan ? (state.demoMode ? "デモ照合" : "読取済み") : "読取待ち");
      return `<tr>
        <td>${file.name}</td>
        <td>${file.employee}</td>
        <td>${kb(file.size)}</td>
        <td><span class="status-badge ${hasScan ? "done" : ""}">${label}</span></td>
      </tr>`;
    })
    .join("");
}

function renderEmployeeOptions() {
  const employees = getEmployees();
  els.employeeSelect.innerHTML = employees.map((name) => `<option value="${name}">${name}</option>`).join("");
  els.employeeSelect.value = state.selectedEmployee;
}

function renderEmployeeSummary() {
  const rows = getEmployees()
    .map(employeeStats)
    .filter((row) => row.employee.includes(state.search))
    .filter((row) => {
      if (state.filter === "matched") return row.matchedQty > 0;
      if (state.filter === "unmatched") return row.unmatchedQty > 0;
      return true;
    });

  const totals = rows.reduce(
    (sum, row) => ({
      matchedQty: sum.matchedQty + row.matchedQty,
      unmatchedQty: sum.unmatchedQty + row.unmatchedQty,
      total: sum.total + row.total,
    }),
    { matchedQty: 0, unmatchedQty: 0, total: 0 },
  );

  els.employeeRanking.innerHTML = rows
    .map(
      (row) => `<tr class="${row.employee === state.selectedEmployee ? "selected" : ""}" data-employee="${row.employee}">
        <td>${row.employee}</td>
        <td class="num">${row.matchedQty || "-"}</td>
        <td class="num">${row.unmatchedQty || "-"}</td>
        <td class="num">${row.total ? yen(row.total) : "-"}</td>
      </tr>`,
    )
    .join("");

  els.summaryQty.textContent = totals.matchedQty;
  els.summaryUnmatched.textContent = totals.unmatchedQty;
  els.summaryTotal.textContent = yen(totals.total);

  els.employeeRanking.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedEmployee = row.dataset.employee;
      render();
    });
  });
}

function renderInspector() {
  const stats = employeeStats(state.selectedEmployee);
  els.employeeItems.textContent = stats.matchedQty || "-";
  els.employeeUnmatched.textContent = stats.unmatchedQty || "-";
  els.employeeTotal.textContent = stats.total ? yen(stats.total) : "-";
  els.detailBody.innerHTML = stats.matched.length
    ? stats.matched
        .map((item) => `<tr><td>${item.barcode}</td><td>${item.productName}</td><td class="num">${item.quantity}</td><td class="num">${yen(item.amount)}</td></tr>`)
        .join("")
    : `<tr><td colspan="4" class="num">データがありません</td></tr>`;

  els.employeeUnmatchedList.innerHTML = stats.unmatched.length
    ? stats.unmatched.map((item) => `<div class="mini-row"><span>${item.barcode}</span><strong>${item.quantity}点</strong></div>`).join("")
    : `<div class="mini-row"><span>データがありません</span><strong>-</strong></div>`;
}

function renderUnmatched() {
  const keyword = els.barcodeSearch.value.trim();
  const rows = state.unmatched.filter((item) => !keyword || item.barcode.includes(keyword));
  els.unmatchedList.innerHTML = rows.length
    ? rows
        .map((item) => `<tr><td>${item.barcode}</td><td class="num">${item.quantity}</td><td>${item.employee}</td><td>${item.reason}</td><td>${item.fileName}</td></tr>`)
        .join("")
    : `<tr><td colspan="5" class="num">未照合データはありません</td></tr>`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function exportCsv(type) {
  const rows =
    type === "summary"
      ? [["社員名", "照合済み点数", "未照合点数", "合計金額"], ...getEmployees().map((employee) => {
          const stats = employeeStats(employee);
          return [employee, stats.matchedQty, stats.unmatchedQty, stats.total];
        })]
      : [["社員名", "バーコード", "商品名", "数量", "単価", "金額"], ...state.matched.map((item) => [item.employee, item.barcode, item.productName, item.quantity, item.price, item.amount])];

  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = type === "summary" ? "staff_sale_employee_summary.csv" : "staff_sale_detail.csv";
  link.click();
  URL.revokeObjectURL(url);
  showToast("CSVを出力しました");
}

let pdfJsReadyPromise = null;

async function ensurePdfJs() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    return window.pdfjsLib;
  }

  pdfJsReadyPromise ||= new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[src*="pdf.min.js"]');
    const script = existingScript || document.createElement("script");
    script.src ||= "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.addEventListener("load", () => resolve(window.pdfjsLib));
    script.addEventListener("error", () => reject(new Error("PDF.jsを読み込めませんでした。インターネット接続を確認してください。")));
    if (!existingScript) document.head.appendChild(script);
  });

  const pdfjs = await pdfJsReadyPromise;
  if (!pdfjs) throw new Error("PDF.jsを読み込めませんでした。インターネット接続を確認してください。");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjs;
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

async function fileToArrayBuffer(file) {
  return await file.arrayBuffer();
}

function extractBarcodeCandidatesFromText(text) {
  const raw = String(text || "");
  const normalized = raw.replace(/[^\d]/g, " ");
  const compact = raw.replace(/[^\d]/g, "");
  const direct = [...normalized.matchAll(/\b\d{8,14}\b/g)].map((match) => match[0]);
  const compactChunks = compact.length >= 8 && compact.length <= 260 ? compact.match(/\d{13}|\d{12}|\d{8}/g) || [] : [];
  return [...new Set([...direct, ...compactChunks])]
    .map((match) => normalizeBarcode(match))
    .filter((value) => value.length === 13 || value.length === 12 || value.length === 8);
}

function addTextCandidates(target, employee, fileName, pageNumber, candidates) {
  candidates.forEach((barcode, index) => {
    const key = `${fileName}:${pageNumber}:text:${barcode}:${index}`;
    target.set(key, { employee, barcode, fileName, page: pageNumber, source: "text" });
  });
}

function canUseBarcodeDetector() {
  return "BarcodeDetector" in window;
}

async function createDetector() {
  if (!canUseBarcodeDetector()) return null;
  const supported = await BarcodeDetector.getSupportedFormats?.();
  const preferred = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar", "qr_code"];
  const formats = supported?.length ? preferred.filter((format) => supported.includes(format)) : preferred;
  return new BarcodeDetector({ formats });
}

function toHighContrastCanvas(source, mode) {
  const canvas = createCanvas(source.width, source.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) total += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  const average = total / (data.length / 4);
  const threshold = mode === "dark" ? Math.max(70, average - 30) : average;

  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    let value;
    if (mode === "contrast") value = gray < average ? Math.max(0, gray - 65) : Math.min(255, gray + 65);
    else value = gray < threshold ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function upscaleCanvas(source, factor) {
  const canvas = createCanvas(source.width * factor, source.height * factor);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function detectOnCanvas(detector, canvas, employee, fileName, pageNumber, target) {
  if (!detector) return;
  const variants = [canvas, toHighContrastCanvas(canvas, "contrast"), toHighContrastCanvas(canvas, "threshold"), toHighContrastCanvas(canvas, "dark")];
  if (canvas.width < 2600) variants.push(upscaleCanvas(canvas, 1.6));

  for (const variant of variants) {
    let detections = [];
    try {
      detections = await detector.detect(variant);
    } catch {
      detections = [];
    }
    detections.forEach((item) => {
      const barcode = normalizeBarcode(item.rawValue);
      if (!barcode || barcode.length < 8) return;
      const box = item.boundingBox || { x: 0, y: 0, width: 0, height: 0 };
      const x = Math.round(((box.x + box.width / 2) / variant.width) * 100);
      const y = Math.round(((box.y + box.height / 2) / variant.height) * 100);
      const key = `${fileName}:${pageNumber}:image:${barcode}:${x}:${y}`;
      target.set(key, { employee, barcode, fileName, page: pageNumber, source: "image" });
    });
  }
}

async function renderPageCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

function aggregateScans(records) {
  const perPage = new Map();
  records.forEach((record) => {
    const key = `${record.employee}|${record.barcode}|${record.fileName}|${record.page}`;
    const current = perPage.get(key) || { ...record, image: 0, text: 0 };
    current[record.source === "image" ? "image" : "text"] += 1;
    perPage.set(key, current);
  });

  const grouped = new Map();
  [...perPage.values()].forEach((record) => {
    const key = `${record.employee}|${record.barcode}|${record.fileName}`;
    const current = grouped.get(key) || { employee: record.employee, barcode: record.barcode, quantity: 0, fileName: record.fileName };
    current.quantity += Math.max(record.image, record.text);
    grouped.set(key, current);
  });
  return [...grouped.values()];
}

async function readPdfBarcodes(files) {
  const pdfjs = await ensurePdfJs();
  const detector = await createDetector();
  const allRecords = [];
  state.readMessages.clear();

  if (!detector) {
    showToast("このブラウザは画像バーコード検出に未対応です。PDF内テキストから抽出します。");
  }

  for (const file of files) {
    const employee = employeeFromFileName(file.name);
    const records = new Map();
    state.readMessages.set(file.name, "解析中");
    renderPdfFiles();

    const pdf = await pdfjs.getDocument({ data: await fileToArrayBuffer(file) }).promise;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item) => item.str).join(" ");
      addTextCandidates(records, employee, file.name, pageNumber, extractBarcodeCandidatesFromText(pageText));

      for (const scale of [2.5, 3.5]) {
        const canvas = await renderPageCanvas(page, scale);
        await detectOnCanvas(detector, canvas, employee, file.name, pageNumber, records);
      }
    }

    const fileRecords = [...records.values()];
    allRecords.push(...fileRecords);
    state.readMessages.set(file.name, `${fileRecords.length}件取得`);
    renderPdfFiles();
  }

  return aggregateScans(allRecords);
}

async function readPdfBarcodesOnBackend(files) {
  const form = new FormData();
  files.forEach((file) => form.append("files", file, file.name));

  const response = await fetch("/api/scan-pdfs", { method: "POST", body: form });
  if (!response.ok) throw new Error(`Backend scan failed: ${response.status}`);
  const payload = await response.json();
  if (!payload.ok || !Array.isArray(payload.items)) throw new Error("Backend scan returned an invalid response");

  state.readMessages.clear();
  payload.files?.forEach((file) => {
    state.readMessages.set(file.fileName, `${file.count}件取得`);
  });
  return payload.items.map((item) => ({
    employee: item.employee,
    barcode: normalizeBarcode(item.barcode),
    quantity: Number(item.quantity) || 1,
    fileName: item.fileName,
  }));
}

function applyBackendScanPayload(payload) {
  state.readMessages.clear();
  payload.files?.forEach((file) => {
    state.readMessages.set(file.fileName, `${file.count}件取得`);
  });

  const scans = payload.items.map((item) => ({
    employee: item.employee,
    barcode: normalizeBarcode(item.barcode),
    quantity: Number(item.quantity) || 1,
    fileName: item.fileName,
  }));

  state.pdfFiles = (payload.files || []).map((file) => ({
    name: file.fileName,
    employee: file.employee,
    size: 0,
  }));
  state.selectedEmployee = state.pdfFiles[0]?.employee || scans[0]?.employee || "";
  els.barcodeInput.value = scans.map((item) => [item.employee, item.barcode, item.quantity, item.fileName].join(",")).join("\n");
  state.demoMode = false;
  runMatch();
  return scans;
}

async function loadSampleScansFromBackend() {
  state.isReading = true;
  render();
  try {
    const response = await fetch("/api/scan-samples");
    if (!response.ok) throw new Error(`Sample scan failed: ${response.status}`);
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.items)) throw new Error(payload.error || "サンプルPDFを集計できませんでした");
    const scans = applyBackendScanPayload(payload);
    showToast(`サンプルPDFを集計しました: ${scans.reduce((sum, item) => sum + item.quantity, 0)}件`);
  } catch (error) {
    console.warn(error);
    showToast(error.message || "サンプルPDFの集計に失敗しました");
  } finally {
    state.isReading = false;
    render();
  }
}

async function loadMasterFromBackend() {
  try {
    const response = await fetch("/api/master");
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.items) || !payload.items.length) return;
    state.master = payload.items.map((item) => ({
      barcode: normalizeBarcode(item.barcode),
      name: item.name,
      price: Number(item.cost ?? item.price) || 0,
    }));
    state.demoMode = false;
    if (els.barcodeInput.value.trim()) runMatch();
    else render();
    showToast(`商品マスタを${state.master.length}件読み込みました（B列JAN / S列原価）`);
    if (!state.selectedFiles.length && !els.barcodeInput.value.trim()) {
      await loadSampleScansFromBackend();
    }
  } catch (error) {
    console.warn(error);
  }
}

async function startPdfReadAndMatch() {
  if (!state.selectedFiles.length) {
    showToast("先にPDFファイルを選択してください");
    return;
  }
  state.isReading = true;
  state.demoMode = false;
  render();

  try {
    let scans;
    try {
      scans = await readPdfBarcodesOnBackend(state.selectedFiles);
      showToast("バックエンドでPDFを解析しました");
    } catch (backendError) {
      console.warn(backendError);
      showToast("バックエンド未起動のためブラウザ解析に切り替えます");
      scans = await readPdfBarcodes(state.selectedFiles);
    }
    els.barcodeInput.value = scans.map((item) => [item.employee, item.barcode, item.quantity, item.fileName].join(",")).join("\n");
    runMatch();
    showToast(`${scans.reduce((sum, item) => sum + item.quantity, 0)}件のバーコードを取得しました`);
  } catch (error) {
    console.error(error);
    showToast(error.message || "PDF読取中にエラーが発生しました");
  } finally {
    state.isReading = false;
    render();
  }
}

els.pdfFile.addEventListener("change", async (event) => {
  const files = [...event.target.files].filter((file) => /\.pdf$/i.test(file.name));
  if (!files.length) return;
  state.selectedFiles = files;
  state.pdfFiles = files.map((file) => ({ name: file.name, employee: employeeFromFileName(file.name), size: file.size }));
  state.selectedEmployee = state.pdfFiles[0]?.employee || "";
  state.demoMode = false;
  state.scans = [];
  state.matched = [];
  state.unmatched = [];
  els.barcodeInput.value = "";
  showToast(`${files.length}件のPDFを読み込みました`);
  render();
});

els.masterFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) {
    showToast("商品マスタはCSV形式に対応しています");
    return;
  }
  const master = parseMaster(await readTextFile(file));
  if (!master.length) {
    showToast("商品マスタを読み込めませんでした");
    return;
  }
  state.master = master;
  state.demoMode = false;
  if (els.barcodeInput.value.trim()) runMatch();
  else render();
  showToast(`商品マスタを${master.length}件読み込みました`);
});

els.employeeSelect.addEventListener("change", (event) => {
  state.selectedEmployee = event.target.value;
  render();
});

els.employeeSearch.addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderEmployeeSummary();
});

els.reasonFilter.addEventListener("change", (event) => {
  state.filter = event.target.value;
  renderEmployeeSummary();
});

els.barcodeSearch.addEventListener("input", renderUnmatched);
document.querySelector("#run-match").addEventListener("click", startPdfReadAndMatch);

document.querySelector("#load-sample").addEventListener("click", () => {
  loadSampleScansFromBackend();
});

document.querySelector("#refresh-list").addEventListener("click", () => {
  renderPdfFiles();
  showToast("PDF一覧を更新しました");
});

els.exportSummary.addEventListener("click", () => exportCsv("summary"));
els.exportDetail.addEventListener("click", () => exportCsv("detail"));

els.barcodeInput.value = "";
render();
loadMasterFromBackend();
