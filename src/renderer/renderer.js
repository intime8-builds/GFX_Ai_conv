"use strict";

const state = {
  settings: null,
  colorInfo: null,
  plate: null,
  track: null,
  analysis: null,
  sourcePreviewUrl: "",
  conformPreviewUrl: "",
  jobs: [],
  running: false,
  paused: false,
  stopping: false,
  activeId: null,
  analysisGeneration: 0
};

const STATUS_LABELS = {
  queued: "в очереди",
  paused: "пауза",
  converting: "обработка",
  done: "готово",
  error: "ошибка",
  stopped: "остановлено"
};

const PHASE_LABELS = {
  preparing: "подготовка",
  conform: "denoise · undistort · OCIO · ProRes",
  padding: "дополнение последним кадром",
  "topview-pass-1": "Topview: анализ",
  "topview-pass-2": "Topview: кодирование",
  qc: "проверка результата",
  done: "готово"
};

const elements = Object.fromEntries(
  Array.from(document.querySelectorAll("[id]")).map((element) => [element.id, element])
);

let pendingUpdate = null;

window.addEventListener("error", (event) => {
  reportLog("error", "windowError", {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error && event.error.stack
  });
});
window.addEventListener("unhandledrejection", (event) => {
  reportLog("error", "unhandledRejection", event.reason);
});

init();

async function init() {
  reportLog("info", "initStart");
  bindEvents();
  elements.versionLabel.textContent = `v${await window.gfxConv.getVersion()} · AI conform`;
  state.settings = await window.gfxConv.getSettings();
  hydrateSettings();
  renderAll();
  await loadColorSpaces();
  checkUpdates(false);

  window.gfxConv.onConformProgress((update) => {
    const job = findJob(update.id);

    if (!job) {
      return;
    }

    job.progress = Number.isFinite(update.progress) ? update.progress : job.progress;
    job.phase = update.phase || job.phase;
    renderJobs();
  });

  window.gfxConv.onUpdateDownloadProgress((update) => {
    if (update.phase === "installing") {
      elements.updateBody.textContent = "Устанавливаю обновление. Приложение перезапустится автоматически.";
      elements.updateProgressFill.style.width = "100%";
      elements.updateProgressText.textContent = "Установка";
      return;
    }

    const progress = update.progress || 0;
    elements.updateProgressFill.style.width = `${progress}%`;
    elements.updateProgressText.textContent = `${progress}%`;
  });
  reportLog("info", "initComplete");
}

function bindEvents() {
  elements.choosePlateButton.addEventListener("click", () => choosePlate("file"));
  elements.choosePlateFolderButton.addEventListener("click", () => choosePlate("folder"));
  elements.chooseTrackButton.addEventListener("click", chooseTrack);
  elements.chooseOutputButton.addEventListener("click", chooseOutput);
  elements.addQueueButton.addEventListener("click", addCurrentJob);
  elements.startQueueButton.addEventListener("click", startQueue);
  elements.pauseQueueButton.addEventListener("click", pauseQueue);
  elements.stopQueueButton.addEventListener("click", stopQueue);
  elements.clearQueueButton.addEventListener("click", clearQueue);
  elements.openOutputButton.addEventListener("click", openCurrentOutput);
  elements.faqButton.addEventListener("click", () => showModal(elements.faqModal));
  elements.closeFaqButton.addEventListener("click", () => hideModal(elements.faqModal));
  elements.collectLogsButton.addEventListener("click", collectLogs);
  elements.updateButton.addEventListener("click", () => checkUpdates(true));
  elements.closeUpdateButton.addEventListener("click", () => hideModal(elements.updateModal));
  elements.downloadUpdateButton.addEventListener("click", downloadAndInstallUpdate);

  elements.autoOutputInput.addEventListener("change", async () => {
    state.settings.outputMode = elements.autoOutputInput.checked ? "auto" : "manual";
    elements.chooseOutputButton.disabled = elements.autoOutputInput.checked;
    await saveSettingsAndAnalyze();
  });

  elements.autoDurationInput.addEventListener("change", async () => {
    state.settings.durationMode = elements.autoDurationInput.checked ? "auto" : "custom";
    elements.durationInput.disabled = elements.autoDurationInput.checked;
    await saveSettingsAndAnalyze();
  });

  elements.durationInput.addEventListener("change", async () => {
    elements.durationInput.value = clampInteger(elements.durationInput.value, 4, 15, 4);
    state.settings.durationSeconds = Number(elements.durationInput.value);
    await saveSettingsAndAnalyze();
  });

  elements.colorSpaceInput.addEventListener("change", async () => {
    state.settings.inputColorSpace = elements.colorSpaceInput.value;
    await saveSettings();
    createSourcePreview();
    await analyzeCurrent();
  });

  elements.resolutionModeInput.addEventListener("change", async () => {
    state.settings.resolutionMode = elements.resolutionModeInput.value === "hd" ? "hd" : "source";
    await saveSettingsAndAnalyze();
  });

  elements.denoiseInput.addEventListener("input", () => {
    state.settings.denoiseStrength = Number(elements.denoiseInput.value);
    elements.denoiseValue.textContent = state.settings.denoiseStrength.toFixed(1);
  });
  elements.denoiseInput.addEventListener("change", saveSettingsAndAnalyze);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) {
      reportLog("info", "buttonClick", {
        id: button.id,
        label: button.textContent.trim(),
        disabled: button.disabled
      });
    }
  });

  document.addEventListener("change", (event) => {
    const control = event.target;
    if (control && control.id) {
      reportLog("info", "controlChange", {
        id: control.id,
        value: control.type === "checkbox" ? control.checked : control.value
      });
    }
  });
}

async function loadColorSpaces() {
  try {
    const info = await window.gfxConv.listColorSpaces();
    state.colorInfo = info;
    elements.colorSpaceInput.innerHTML = "";

    for (const name of info.colorSpaces) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      elements.colorSpaceInput.append(option);
    }

    const requested = state.settings.inputColorSpace;
    elements.colorSpaceInput.value = info.colorSpaces.includes(requested) ? requested : info.defaultInput;
    state.settings.inputColorSpace = elements.colorSpaceInput.value;
    elements.colorSpaceInput.disabled = false;
    elements.runtimeStatus.textContent = `${info.runtime} · OCIO ${info.ocioVersion}`;
    elements.runtimeStatus.className = "runtime-status";
    await saveSettings();
    await analyzeCurrent();
  } catch (error) {
    elements.runtimeStatus.textContent = "OCIO недоступен";
    elements.runtimeStatus.className = "runtime-status error";
    elements.setupStatus.textContent = error.message || "Не удалось загрузить Nuke OCIO.";
    showToast(error.message || "Не удалось загрузить Nuke OCIO.");
    renderSetup();
  }
}

function hydrateSettings() {
  elements.autoOutputInput.checked = state.settings.outputMode !== "manual";
  elements.chooseOutputButton.disabled = elements.autoOutputInput.checked;
  elements.outputPath.value = elements.autoOutputInput.checked
    ? ""
    : state.settings.outputDir || "";
  elements.autoDurationInput.checked = state.settings.durationMode !== "custom";
  elements.durationInput.disabled = elements.autoDurationInput.checked;
  elements.durationInput.value = clampInteger(state.settings.durationSeconds, 4, 15, 4);
  elements.resolutionModeInput.value = state.settings.resolutionMode === "hd" ? "hd" : "source";
  elements.denoiseInput.value = clampNumber(state.settings.denoiseStrength, 0, 2, 1);
  elements.denoiseValue.textContent = Number(elements.denoiseInput.value).toFixed(1);
}

async function choosePlate(sourceType) {
  setSetupBusy(true, "Читаю исходный plate…");
  try {
    const plate = sourceType === "folder"
      ? await window.gfxConv.choosePlateFolder()
      : await window.gfxConv.choosePlate();

    if (!plate) {
      return;
    }

    state.plate = plate;
    state.analysis = null;
    state.sourcePreviewUrl = "";
    state.conformPreviewUrl = "";
    elements.platePath.value = plate.selectedPath;
    state.settings.lastPlateDir = parentDirectory(plate.selectedPath);
    renderSetup();
    createSourcePreview();
    await analyzeCurrent();
  } catch (error) {
    showToast(error.message || "Не удалось открыть plate.");
  } finally {
    setSetupBusy(false);
  }
}

async function chooseTrack() {
  setSetupBusy(true, "Ищу последнюю версию трека…");
  try {
    const track = await window.gfxConv.chooseTrack();
    if (!track) {
      return;
    }

    state.track = track;
    state.analysis = null;
    state.conformPreviewUrl = "";
    elements.trackPath.value = track.filePath;
    state.settings.lastTrackDir = track.cameraDir;
    renderSetup();
    await analyzeCurrent();
  } catch (error) {
    showToast(error.message || "Не удалось открыть трек.");
  } finally {
    setSetupBusy(false);
  }
}

async function chooseOutput() {
  const outputDir = await window.gfxConv.chooseOutputDir();
  if (!outputDir) {
    return;
  }

  state.settings.outputMode = "manual";
  state.settings.outputDir = outputDir;
  elements.autoOutputInput.checked = false;
  elements.chooseOutputButton.disabled = false;
  elements.outputPath.value = outputDir;
  await saveSettingsAndAnalyze();
}

async function analyzeCurrent() {
  const generation = ++state.analysisGeneration;

  if (!state.plate || !state.track || !state.colorInfo) {
    state.analysis = null;
    renderSetup();
    return;
  }

  if (state.settings.outputMode === "manual" && !state.settings.outputDir) {
    state.analysis = null;
    renderSetup();
    return;
  }

  elements.setupStatus.textContent = "Рассчитываю длительность и холст…";
  elements.addQueueButton.disabled = true;

  try {
    const analysis = await window.gfxConv.analyzeConform({
      plate: state.plate,
      track: state.track,
      settings: state.settings
    });

    if (generation !== state.analysisGeneration) {
      return;
    }

    state.analysis = analysis;
    state.settings.lastResolvedOutputDir = analysis.outputDir;
    elements.outputPath.value = analysis.outputDir;
    renderSetup();
    await saveSettings();
    createConformPreview(generation);
  } catch (error) {
    if (generation === state.analysisGeneration) {
      state.analysis = null;
      elements.setupStatus.textContent = error.message || "Анализ не выполнен.";
      showToast(error.message || "Анализ не выполнен.");
      renderSetup();
    }
  }
}

async function createSourcePreview() {
  const plate = state.plate;
  const inputColorSpace = state.settings.inputColorSpace;
  if (!plate || !state.colorInfo) {
    return;
  }

  state.sourcePreviewUrl = "";
  elements.sourcePreview.innerHTML = "<span>Применяю OCIO к исходному plate…</span>";

  try {
    const url = await window.gfxConv.createSourcePreview({
      id: crypto.randomUUID(),
      plate,
      settings: state.settings
    });

    if (
      state.plate === plate
      && state.settings.inputColorSpace === inputColorSpace
      && url
    ) {
      state.sourcePreviewUrl = url;
      renderPreviews();
    }
  } catch (error) {
    if (state.plate === plate && state.settings.inputColorSpace === inputColorSpace) {
      elements.sourcePreview.innerHTML = `<span>${escapeHtml(error.message || "Превью недоступно")}</span>`;
    }
  }
}

async function createConformPreview(generation) {
  state.conformPreviewUrl = "";
  elements.conformPreview.innerHTML = "<span>Рассчитываю conform preview…</span>";

  try {
    const url = await window.gfxConv.createConformPreview({
      id: crypto.randomUUID(),
      plate: state.plate,
      track: state.track,
      analysis: state.analysis,
      settings: state.settings
    });

    if (generation === state.analysisGeneration && url) {
      state.conformPreviewUrl = url;
      renderPreviews();
    }
  } catch (error) {
    if (generation === state.analysisGeneration) {
      elements.conformPreview.innerHTML = `<span>${escapeHtml(error.message || "Превью недоступно")}</span>`;
    }
  }
}

async function saveSettingsAndAnalyze() {
  await saveSettings();
  await analyzeCurrent();
}

async function saveSettings() {
  state.settings = await window.gfxConv.saveSettings(state.settings);
}

function addCurrentJob() {
  if (!state.plate || !state.track || !state.analysis) {
    showToast("Задание ещё не готово.");
    return;
  }

  const job = {
    id: crypto.randomUUID(),
    plate: deepClone(state.plate),
    track: deepClone(state.track),
    analysis: deepClone(state.analysis),
    settings: deepClone(state.settings),
    sourcePreviewUrl: state.sourcePreviewUrl,
    conformPreviewUrl: state.conformPreviewUrl,
    status: "queued",
    progress: 0,
    phase: "queued"
  };
  state.jobs.push(job);
  renderJobs();
  showToast(`${job.analysis.shotName} добавлен в очередь.`);
}

async function startQueue() {
  if (state.running) {
    state.paused = false;
    state.jobs.filter((job) => job.status === "paused").forEach((job) => {
      job.status = "queued";
    });
    renderJobs();
    return;
  }

  if (!state.jobs.some(isRunnable)) {
    showToast("В очереди нет заданий для запуска.");
    return;
  }

  state.running = true;
  state.paused = false;
  state.stopping = false;
  renderJobs();

  while (state.running && !state.paused && !state.stopping) {
    const job = state.jobs.find(isRunnable);
    if (!job) {
      break;
    }

    state.activeId = job.id;
    job.status = "converting";
    job.phase = "preparing";
    job.error = "";
    renderJobs();

    try {
      const result = await window.gfxConv.runConform(job);
      Object.assign(job, result);
      job.phase = "done";
    } catch (error) {
      job.status = state.stopping ? "stopped" : "error";
      job.error = error.message || "Conform не выполнен.";
    } finally {
      state.activeId = null;
      renderJobs();
    }
  }

  if (state.paused) {
    state.jobs.filter((job) => job.status === "queued").forEach((job) => {
      job.status = "paused";
    });
  }

  state.running = false;
  state.stopping = false;
  renderJobs();
}

function pauseQueue() {
  if (!state.running) {
    return;
  }

  state.paused = true;
  showToast("Очередь остановится после текущего shot.");
  renderJobs();
}

async function stopQueue() {
  state.stopping = true;
  state.paused = false;

  if (state.activeId) {
    await window.gfxConv.cancelConform();
  }

  state.jobs.filter(isRunnable).forEach((job) => {
    job.status = "stopped";
  });
  renderJobs();
}

async function clearQueue() {
  if (state.activeId) {
    state.stopping = true;
    await window.gfxConv.cancelConform();
  }

  state.jobs = [];
  state.running = false;
  state.paused = false;
  state.stopping = false;
  state.activeId = null;
  renderJobs();
}

function openCurrentOutput() {
  const outputDir = state.analysis?.outputDir
    || state.jobs.at(-1)?.analysis.outputDir
    || state.settings.lastResolvedOutputDir;

  if (!outputDir) {
    showToast("Папка вывода ещё не определена.");
    return;
  }

  window.gfxConv.openPath(outputDir);
}

function renderAll() {
  renderSetup();
  renderPreviews();
  renderJobs();
}

function renderSetup() {
  if (state.plate) {
    const media = state.plate.media;
    elements.plateSpec.textContent = `${media.width}×${media.height} · ${formatFps(media.fps)} fps · ${state.plate.frameCount || media.frameCount} кадр.`;
  } else {
    elements.plateSpec.textContent = "—";
  }

  if (state.track) {
    const animation = state.track.animated ? "анимирован" : "статический";
    elements.trackSpec.textContent = `v${String(state.track.version || 0).padStart(3, "0")} · ${animation}`;
  } else {
    elements.trackSpec.textContent = "—";
  }

  if (state.analysis) {
    elements.durationSpec.textContent = `${state.analysis.duration.targetSeconds} сек · ${formatFps(state.analysis.fps)} fps`;
    elements.canvasSpec.textContent = `${state.analysis.canvas.width}×${state.analysis.canvas.height}`;
    elements.setupStatus.textContent = `${state.analysis.shotName} готов к постановке в очередь`;
    elements.outputPath.value = state.analysis.outputDir;
  } else {
    elements.durationSpec.textContent = "—";
    elements.canvasSpec.textContent = "—";
    if (!state.plate || !state.track) {
      elements.setupStatus.textContent = "Выберите исходный plate и трек камеры";
    }
  }

  elements.warningList.innerHTML = state.analysis?.warnings?.map(
    (warning) => `<li>${escapeHtml(warning)}</li>`
  ).join("") || "";
  elements.addQueueButton.disabled = !state.analysis || !state.colorInfo;
  elements.chooseOutputButton.disabled = elements.autoOutputInput.checked;
}

function renderPreviews() {
  renderPreview(elements.sourcePreview, state.sourcePreviewUrl, "Исходный plate");
  renderPreview(elements.conformPreview, state.conformPreviewUrl, "Conform preview");
}

function renderPreview(container, url, fallback) {
  if (url) {
    container.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
  } else if (!container.textContent.includes("Рассчитываю")) {
    container.innerHTML = `<span>${escapeHtml(fallback)}</span>`;
  }
}

function renderJobs() {
  elements.queueSummary.textContent = queueSummary();
  renderQueueButtons();

  if (state.jobs.length === 0) {
    elements.jobList.innerHTML = '<li class="empty-queue">В очереди нет заданий</li>';
    return;
  }

  elements.jobList.innerHTML = state.jobs.map((job) => {
    const progress = Number.isFinite(job.progress) ? job.progress : 0;
    const detail = job.error || job.mainPath || PHASE_LABELS[job.phase] || job.analysis.outputDir;
    const preview = job.conformPreviewUrl || job.sourcePreviewUrl;
    const statusLabel = STATUS_LABELS[job.status] || job.status;
    const openButton = job.mainPath
      ? `<button type="button" data-open="${escapeHtml(job.mainPath)}">Открыть MOV</button>`
      : "";

    return `
      <li class="job-item">
        ${preview ? `<img class="job-thumb" src="${escapeHtml(preview)}" alt="">` : '<div class="job-thumb"></div>'}
        <div class="job-main">
          <div class="job-name">${escapeHtml(job.analysis.shotName)}</div>
          <div class="job-spec">${escapeHtml(job.settings.inputColorSpace)} · ${formatFps(job.analysis.fps)} fps · ${job.analysis.duration.targetSeconds} сек · ${job.analysis.canvas.width}×${job.analysis.canvas.height}</div>
          <div class="job-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>
          <div class="progress-row">
            <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
            <span>${progress}%</span>
          </div>
        </div>
        <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(statusLabel)}</span>
        <div class="job-actions">
          ${openButton}
          <button type="button" data-output="${escapeHtml(job.analysis.outputDir)}">Папка</button>
          <button type="button" data-repeat="${escapeHtml(job.id)}">Повторить</button>
        </div>
      </li>
    `;
  }).join("");

  elements.jobList.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", () => window.gfxConv.openPath(button.dataset.open));
  });
  elements.jobList.querySelectorAll("[data-output]").forEach((button) => {
    button.addEventListener("click", () => window.gfxConv.openPath(button.dataset.output));
  });
  elements.jobList.querySelectorAll("[data-repeat]").forEach((button) => {
    button.addEventListener("click", () => repeatJob(button.dataset.repeat));
  });
}

function repeatJob(id) {
  const source = findJob(id);
  if (!source) {
    return;
  }

  const copy = deepClone(source);
  copy.id = crypto.randomUUID();
  copy.status = "queued";
  copy.progress = 0;
  copy.phase = "queued";
  delete copy.error;
  delete copy.mainPath;
  delete copy.topviewPath;
  delete copy.reportPath;
  state.jobs.push(copy);
  renderJobs();
}

function renderQueueButtons() {
  const hasJobs = state.jobs.length > 0;
  const hasRunnable = state.jobs.some(isRunnable);
  elements.startQueueButton.disabled = !hasRunnable || (state.running && !state.paused);
  elements.pauseQueueButton.disabled = !state.running || state.paused;
  elements.stopQueueButton.disabled = !hasJobs || (!state.activeId && !hasRunnable);
  elements.clearQueueButton.disabled = !hasJobs;
}

function queueSummary() {
  if (state.jobs.length === 0) {
    return "0 заданий";
  }

  const done = state.jobs.filter((job) => job.status === "done").length;
  const active = state.activeId ? " · выполняется" : "";
  const paused = state.paused ? " · пауза после текущего" : "";
  return `${done}/${state.jobs.length} готово${active}${paused}`;
}

async function collectLogs() {
  const button = elements.collectLogsButton;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Собираю…";

  try {
    const result = await window.gfxConv.collectLogs({
      capturedAt: new Date().toISOString(),
      running: state.running,
      paused: state.paused,
      stopping: state.stopping,
      activeId: state.activeId,
      plate: state.plate,
      track: state.track,
      analysis: state.analysis,
      settings: state.settings,
      jobs: state.jobs
    });

    if (result && result.path) {
      showToast(`Логи собраны: ${result.path}`);
    }
  } catch (error) {
    showToast(error.message || "Не удалось собрать диагностические логи.");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function checkUpdates(showNoUpdate) {
  elements.updateButton.disabled = true;
  try {
    const result = await window.gfxConv.checkUpdates();
    if (!result.ok) {
      if (showNoUpdate) {
        showToast(`Не удалось проверить обновления: ${result.error}`);
      }
      return;
    }

    if (result.hasUpdate && result.installerAsset) {
      pendingUpdate = result;
      elements.updateTitle.textContent = `Доступна версия ${result.releaseName || result.latestVersion}`;
      elements.updateBody.textContent = `Текущая версия: ${result.currentVersion}. Установщик будет скачан и запущен без перехода на GitHub.`;
      elements.updateProgressWrap.classList.add("hidden");
      elements.downloadUpdateButton.disabled = false;
      elements.closeUpdateButton.disabled = false;
      showModal(elements.updateModal);
    } else if (showNoUpdate) {
      showToast("Установлена последняя версия.");
    }
  } finally {
    elements.updateButton.disabled = false;
  }
}

async function downloadAndInstallUpdate() {
  if (!pendingUpdate) {
    return;
  }

  elements.downloadUpdateButton.disabled = true;
  elements.closeUpdateButton.disabled = true;
  elements.updateBody.textContent = "Скачиваю обновление…";
  elements.updateProgressWrap.classList.remove("hidden");

  try {
    await window.gfxConv.downloadAndInstallUpdate();
  } catch (error) {
    elements.downloadUpdateButton.disabled = false;
    elements.closeUpdateButton.disabled = false;
    showToast(error.message || "Не удалось установить обновление.");
  }
}

function setSetupBusy(busy, message = "") {
  elements.choosePlateButton.disabled = busy;
  elements.choosePlateFolderButton.disabled = busy;
  elements.chooseTrackButton.disabled = busy;
  if (busy && message) {
    elements.setupStatus.textContent = message;
  }
}

function showModal(modal) {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function hideModal(modal) {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function showToast(message) {
  reportLog("info", "toast", { message });
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 5000);
}

function reportLog(level, event, details = null) {
  try {
    window.gfxConv.log(level, event, details);
  } catch (_error) {
    // Logging must never interfere with the UI.
  }
}

function findJob(id) {
  return state.jobs.find((job) => job.id === id);
}

function isRunnable(job) {
  return job.status === "queued" || job.status === "paused";
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parentDirectory(filePath) {
  return String(filePath).replace(/[\\/][^\\/]+$/, "");
}

function formatFps(value) {
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
