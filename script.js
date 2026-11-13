const SPEED_TEST_BASE = "https://speed.cloudflare.com";
const DOWNLOAD_SIZES = [250_000, 1_000_000, 5_000_000];
const UPLOAD_SIZES = [250_000, 1_000_000, 3_000_000];
const MAX_HISTORY = 20;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 119;

const elements = {
  start: document.querySelector("#start-button"),
  buttonLabel: document.querySelector("#button-label"),
  value: document.querySelector("#gauge-value"),
  caption: document.querySelector("#gauge-caption"),
  phase: document.querySelector("#gauge-phase"),
  progress: document.querySelector("#gauge-progress"),
  status: document.querySelector("#test-status"),
  statusPill: document.querySelector(".live-status"),
  connection: document.querySelector("#connection-label"),
  download: document.querySelector("#download-value"),
  upload: document.querySelector("#upload-value"),
  ping: document.querySelector("#ping-value"),
  jitter: document.querySelector("#jitter-value"),
  summary: document.querySelector("#summary-text"),
  resultSummary: document.querySelector("#result-summary"),
  history: document.querySelector("#history-card"),
  clearHistory: document.querySelector("#clear-history"),
  toast: document.querySelector("#toast")
};

let testController = null;
let toastTimeout;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(value);
}

function setGauge(value, phase, progress, caption = "ВАША СКОРОСТЬ") {
  elements.value.textContent = value === null ? "—" : formatNumber(value);
  elements.caption.textContent = caption;
  elements.phase.textContent = phase;
  const fill = Math.max(0, Math.min(1, progress));
  elements.progress.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE}`;
  elements.progress.style.strokeDashoffset = `${GAUGE_CIRCUMFERENCE * (1 - fill)}`;
  elements.gaugeLabel = `${phase}${value === null ? "" : `: ${formatNumber(value)} мегабит в секунду`}`;
  document.querySelector("#gauge").setAttribute("aria-label", elements.gaugeLabel);
}

function setPhase(phase, state = "active") {
  elements.phase.textContent = phase;
  elements.status.textContent = state === "active" ? phase.toUpperCase() : state.toUpperCase();
  elements.statusPill.classList.toggle("active", state === "active");
}

function setMetric(id, value, unit, rowId) {
  document.querySelector(`#${id}`).textContent = formatNumber(value);
  document.querySelector(`#${rowId}`).classList.add("complete");
  document.querySelector(`#${rowId}`).querySelector(".metric-value span").textContent = unit;
}

function resetMetrics() {
  for (const [id, row] of [["download-value", "download-row"], ["upload-value", "upload-row"], ["ping-value", "ping-row"], ["jitter-value", "jitter-row"]]) {
    document.querySelector(`#${id}`).textContent = "—";
    document.querySelector(`#${row}`).classList.remove("complete", "measuring");
  }
  elements.progress.style.stroke = "";
}

function setMeasuringMetric(rowId) {
  document.querySelectorAll(".metric-row").forEach((row) => row.classList.remove("measuring"));
  document.querySelector(`#${rowId}`).classList.add("measuring");
}

function notify(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => elements.toast.classList.remove("visible"), 4000);
}

function testUrl(path, bytes) {
  const query = new URLSearchParams({ bytes: String(bytes), cache: String(Date.now() + Math.random()) });
  return `${SPEED_TEST_BASE}/${path}?${query}`;
}

async function latencyProbe(signal) {
  const started = performance.now();
  const response = await fetch(testUrl("__down", 0), { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Сервер измерения вернул ошибку ${response.status}`);
  await response.arrayBuffer();
  return performance.now() - started;
}

async function measureTransfer(direction, bytes, signal) {
  const started = performance.now();
  let response;
  if (direction === "download") {
    response = await fetch(testUrl("__down", bytes), { cache: "no-store", signal });
    if (!response.ok) throw new Error(`Сервер измерения вернул ошибку ${response.status}`);
    const data = await response.arrayBuffer();
    if (data.byteLength < bytes * .9) throw new Error("Сервер измерения передал не все данные");
  } else {
    const payload = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 1024) payload[i] = i % 251;
    response = await fetch(testUrl("__up", 0), { method: "POST", body: payload, cache: "no-store", signal });
    if (!response.ok) throw new Error(`Сервер измерения вернул ошибку ${response.status}`);
    await response.arrayBuffer();
  }
  const seconds = Math.max((performance.now() - started) / 1000, .001);
  return (bytes * 8) / seconds / 1_000_000;
}

async function measureLatency(signal) {
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    samples.push(await latencyProbe(signal));
    if (i < 5) await new Promise((resolve) => window.setTimeout(resolve, 90));
  }
  const warmedSamples = samples.slice(1);
  const ping = median(warmedSamples);
  const differences = warmedSamples.slice(1).map((sample, index) => Math.abs(sample - warmedSamples[index]));
  const jitter = differences.length
    ? median(differences)
    : 0;
  return { ping, jitter };
}

async function measureDirection(direction, sizes, signal, onProgress) {
  const speeds = [];
  for (let index = 0; index < sizes.length; index += 1) {
    speeds.push(await measureTransfer(direction, sizes[index], signal));
    onProgress(index + 1, sizes.length, speeds.at(-1));
  }
  return median(speeds);
}

function recommendation(download, upload, ping) {
  if (download >= 100 && ping < 30) return "Очень быстрое соединение — отлично подойдёт для потокового видео и игр.";
  if (download >= 25) return "Комфортной скорости хватит для видео, видеозвонков и повседневных задач.";
  if (download >= 5) return "Подойдёт для сайтов и звонков. Для нескольких потоков видео может не хватить скорости.";
  return "Соединение медленное. Попробуйте приблизиться к роутеру или подключиться по кабелю.";
}

async function readHistory() {
  try {
    const response = await fetch("/api/tests", { cache: "no-store" });
    if (!response.ok) throw new Error(`API истории недоступен (${response.status})`);
    return await response.json();
  } catch (error) {
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") console.info("Используем локальную историю браузера:", error);
    return JSON.parse(localStorage.getItem("pulse-history") || "[]");
  }
}

async function saveResult(result) {
  try {
    const response = await fetch("/api/tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    });
    if (!response.ok) throw new Error(`API истории недоступен (${response.status})`);
    return await response.json();
  } catch (error) {
    console.info("Сохраняем результат локально:", error);
    const history = JSON.parse(localStorage.getItem("pulse-history") || "[]");
    const localResult = { ...result, id: Date.now(), created_at: new Date().toISOString() };
    localHistoryWrite([localResult, ...history].slice(0, MAX_HISTORY));
    return localResult;
  }
}

function localHistoryWrite(history) {
  try {
    localStorage.setItem("pulse-history", JSON.stringify(history));
  } catch (error) {
    console.error("Не удалось сохранить историю в браузере:", error);
    notify("Результат измерен, но сохранить историю не удалось.", true);
  }
}

function formatDate(value) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "Недавно";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function renderHistoryRows(items) {
  const table = document.createElement("table");
  table.className = "history-list";
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  ["ДАТА", "ЗАГРУЗКА", "ОТДАЧА", "ПИНГ", "ДЖИТТЕР", ""].forEach((label) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    heading.append(cell);
  });
  head.append(heading);
  const body = document.createElement("tbody");
  items.forEach((item) => {
    const row = document.createElement("tr");
    const date = document.createElement("td");
    date.textContent = formatDate(item.created_at || "");
    row.append(date);
    [["download_mbps", "Мбит/с"], ["upload_mbps", "Мбит/с"], ["ping_ms", "мс"], ["jitter_ms", "мс"]].forEach(([key, unit]) => {
      const cell = document.createElement("td");
      const value = document.createElement("span");
      value.className = "history-number";
      value.textContent = formatNumber(item[key]);
      cell.append(value, document.createTextNode(` ${unit}`));
      row.append(cell);
    });
    const action = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Удалить результат из истории");
    remove.addEventListener("click", () => deleteResult(item.id));
    action.append(remove);
    row.append(action);
    body.append(row);
  });
  table.append(head, body);
  elements.history.replaceChildren(table);
}

async function renderHistory() {
  const history = await readHistory();
  elements.clearHistory.hidden = history.length === 0;
  if (history.length) {
    renderHistoryRows(history.slice(0, MAX_HISTORY));
    return;
  }
  const empty = document.createElement("div");
  empty.className = "history-empty";
  empty.innerHTML = '<div class="empty-rings"><span></span><span></span><span></span></div><p>Здесь появятся результаты</p><small>История сохранится после следующей проверки</small>';
  elements.history.replaceChildren(empty);
}

async function deleteResult(id) {
  try {
    const response = await fetch(`/api/tests/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Не удалось удалить результат (${response.status})`);
  } catch (error) {
    const history = JSON.parse(localStorage.getItem("pulse-history") || "[]");
    localHistoryWrite(history.filter((item) => String(item.id) !== String(id)));
  }
  await renderHistory();
}

async function clearHistory() {
  try {
    const response = await fetch("/api/tests", { method: "DELETE" });
    if (!response.ok) throw new Error(`Не удалось очистить историю (${response.status})`);
  } catch (error) {
    localStorage.removeItem("pulse-history");
  }
  await renderHistory();
  notify("История тестов очищена.");
}

function finishTest() {
  elements.start.disabled = false;
  elements.start.classList.remove("running");
  elements.buttonLabel.textContent = "Проверить ещё раз";
  document.querySelectorAll(".metric-row").forEach((row) => row.classList.remove("measuring"));
}

async function runTest() {
  if (testController) {
    testController.abort();
    testController = null;
    return;
  }

  testController = new AbortController();
  const { signal } = testController;
  elements.start.disabled = false;
  elements.start.classList.add("running");
  elements.buttonLabel.textContent = "Отменить тест";
  elements.caption.textContent = "ВАША СКОРОСТЬ";
  elements.statusPill.classList.add("active");
  resetMetrics();
  elements.summary.textContent = "Измеряем качество соединения. Пожалуйста, не закрывайте страницу.";
  elements.resultSummary.classList.remove("error-summary");
  let download = null;
  let upload = null;
  let ping = null;
  let jitter = null;

  try {
    setPhase("Пинг");
    setGauge(null, "измеряем задержку", .04, "ЗАДЕРЖКА");
    setMeasuringMetric("ping-row");
    ({ ping, jitter } = await measureLatency(signal));
    setMetric("ping-value", ping, "мс", "ping-row");
    setMetric("jitter-value", jitter, "мс", "jitter-row");

    setPhase("Загрузка");
    setGauge(null, "измеряем загрузку", .12, "DOWNLOAD");
    setMeasuringMetric("download-row");
    download = await measureDirection("download", DOWNLOAD_SIZES, signal, (completed, total, speed) => {
      const progress = .12 + .43 * (completed / total);
      setGauge(speed, "загрузка", progress, "DOWNLOAD");
    });
    setMetric("download-value", download, "Мбит/с", "download-row");

    setPhase("Отдача");
    setGauge(null, "измеряем отдачу", .56, "UPLOAD");
    setMeasuringMetric("upload-row");
    upload = await measureDirection("upload", UPLOAD_SIZES, signal, (completed, total, speed) => {
      const progress = .56 + .4 * (completed / total);
      setGauge(speed, "отдача", progress, "UPLOAD");
    });
    setMetric("upload-value", upload, "Мбит/с", "upload-row");

    setGauge(download, "тест завершён", 1, "DOWNLOAD");
    elements.summary.textContent = recommendation(download, upload, ping);
    setPhase("Готово", "Готово");
    elements.connection.textContent = "Соединение активно";
    await saveResult({ download_mbps: download, upload_mbps: upload, ping_ms: ping, jitter_ms: jitter });
    await renderHistory();
    notify("Проверка завершена. Результат добавлен в историю.");
  } catch (error) {
    if (signal.aborted) {
      setPhase("Остановлено", "Остановлено");
      setGauge(null, "проверка отменена", 0);
      elements.summary.textContent = "Проверка остановлена. Запустите тест ещё раз, когда будете готовы.";
    } else {
      console.error("Ошибка измерения скорости:", error);
      setPhase("Ошибка", "Ошибка");
      setGauge(null, "не удалось измерить", 0);
      elements.summary.textContent = "Не удалось связаться с сервером измерений. Проверьте подключение и блокировщики запросов.";
      elements.resultSummary.classList.add("error-summary");
      elements.connection.textContent = "Сервер измерений недоступен";
      notify("Не удалось завершить тест. Проверьте подключение к Cloudflare и попробуйте ещё раз.", true);
    }
  } finally {
    finishTest();
    testController = null;
  }
}

elements.start.addEventListener("click", runTest);
elements.clearHistory.addEventListener("click", clearHistory);

if (navigator.onLine) elements.connection.textContent = "Соединение активно";
window.addEventListener("online", () => { elements.connection.textContent = "Соединение активно"; });
window.addEventListener("offline", () => { elements.connection.textContent = "Нет подключения"; });
renderHistory();
