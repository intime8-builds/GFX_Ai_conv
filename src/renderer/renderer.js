const state = {
  mode: "png",
  outputDir: "",
  items: [],
  running: false,
  paused: false,
  stopping: false,
  activeId: null
};

const STATUS_LABELS = {
  queued: "в очереди",
  paused: "пауза",
  converting: "конвертация",
  done: "готово",
  error: "ошибка",
  stopped: "остановлено"
};

const modeButtons = document.querySelectorAll(".mode-button");
const outputDirInput = document.querySelector("#outputDir");
const chooseOutputButton = document.querySelector("#chooseOutput");
const dropzone = document.querySelector("#dropzone");
const dropTitle = document.querySelector("#dropTitle");
const dropSubtitle = document.querySelector("#dropSubtitle");
const filePicker = document.querySelector("#filePicker");
const fileList = document.querySelector("#fileList");
const queueSummary = document.querySelector("#queueSummary");
const videoSettings = document.querySelector("#videoSettings");
const durationFullInput = document.querySelector("#durationFullInput");
const durationInput = document.querySelector("#durationInput");
const outputSpec = document.querySelector("#outputSpec");
const colorSpaceInput = document.querySelector("#colorSpaceInput");
const sourceSizeInput = document.querySelector("#sourceSizeInput");
const widthInput = document.querySelector("#widthInput");
const heightInput = document.querySelector("#heightInput");
const openOutputButton = document.querySelector("#openOutput");
const startQueueButton = document.querySelector("#startQueue");
const pauseQueueButton = document.querySelector("#pauseQueue");
const stopQueueButton = document.querySelector("#stopQueue");
const clearQueueButton = document.querySelector("#clearQueue");
const toast = document.querySelector("#toast");
const versionLabel = document.querySelector("#versionLabel");
const faqButton = document.querySelector("#faqButton");
const updateButton = document.querySelector("#updateButton");
const updateModal = document.querySelector("#updateModal");
const updateTitle = document.querySelector("#updateTitle");
const updateBody = document.querySelector("#updateBody");
const updateProgressWrap = document.querySelector("#updateProgressWrap");
const updateProgressFill = document.querySelector("#updateProgressFill");
const updateProgressText = document.querySelector("#updateProgressText");
const downloadUpdateButton = document.querySelector("#downloadUpdate");
const closeUpdateModalButton = document.querySelector("#closeUpdateModal");
const faqModal = document.querySelector("#faqModal");
const closeFaqModalButton = document.querySelector("#closeFaqModal");

let pendingUpdate = null;

init();

async function init() {
  bindEvents();
  await hydrateVersion();
  await hydrateSettings();
  updateDropzoneState();
  renderFileList();
  checkUpdates(false);

  window.gfxConv.onConversionProgress((update) => {
    const item = findItem(update.id);

    if (!item) {
      return;
    }

    Object.assign(item, update);
    renderFileList();
  });

  window.gfxConv.onUpdateDownloadProgress((update) => {
    if (update.phase === "installing") {
      updateBody.textContent = "Устанавливаю обновление в тихом режиме. Приложение перезапустится автоматически.";
      updateProgressFill.style.width = "100%";
      updateProgressText.textContent = "Установка";
      return;
    }

    const progress = update.progress || 0;
    updateProgressFill.style.width = `${progress}%`;
    updateProgressText.textContent = `${progress}%`;
  });
}

function bindEvents() {
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setMode(button.dataset.mode, true);
    });
  });

  chooseOutputButton.addEventListener("click", async () => {
    const selectedDir = await window.gfxConv.chooseOutputDir();

    if (!selectedDir) {
      return;
    }

    state.outputDir = selectedDir;
    outputDirInput.value = selectedDir;
    updateDropzoneState();
    saveCurrentSettings();
  });

  openOutputButton.addEventListener("click", () => {
    if (!state.outputDir) {
      showToast("Сначала выберите папку вывода.");
      return;
    }

    window.gfxConv.openPath(state.outputDir);
  });

  updateButton.addEventListener("click", () => checkUpdates(true));
  faqButton.addEventListener("click", showFaqModal);
  closeFaqModalButton.addEventListener("click", hideFaqModal);
  closeUpdateModalButton.addEventListener("click", hideUpdateModal);
  downloadUpdateButton.addEventListener("click", downloadAndInstallUpdate);
  startQueueButton.addEventListener("click", startQueue);
  pauseQueueButton.addEventListener("click", pauseQueue);
  stopQueueButton.addEventListener("click", stopQueue);
  clearQueueButton.addEventListener("click", clearQueue);

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();

    if (!state.outputDir) {
      dropzone.classList.add("blocked");
      return;
    }

    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover", "blocked");
  });

  dropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover", "blocked");
    await addFiles(event.dataTransfer.files);
  });

  filePicker.addEventListener("change", async () => {
    await addFiles(filePicker.files);
    filePicker.value = "";
  });

  durationFullInput.addEventListener("change", () => {
    durationInput.disabled = durationFullInput.checked;
    saveCurrentSettings();
  });

  durationInput.addEventListener("change", () => {
    durationInput.value = clampInteger(durationInput.value, 1, 86400, 4);
    saveCurrentSettings();
  });

  sourceSizeInput.addEventListener("change", () => {
    updateResolutionInputs();
    saveCurrentSettings();
  });

  [widthInput, heightInput].forEach((input) => {
    input.addEventListener("change", () => {
      input.value = clampInteger(input.value, 1, 16384, input.id === "widthInput" ? 1920 : 1080);
      saveCurrentSettings();
    });
  });

  colorSpaceInput.addEventListener("change", () => {
    updateOutputSpec();
    saveCurrentSettings();
  });
}

async function hydrateVersion() {
  const version = await window.gfxConv.getVersion();
  versionLabel.textContent = `v${version}`;
}

async function hydrateSettings() {
  const settings = await window.gfxConv.getSettings();
  const video = settings.video || {};
  const outputSize = video.outputSize || {};

  state.outputDir = settings.outputDir || "";
  outputDirInput.value = state.outputDir;
  durationFullInput.checked = video.durationMode !== "custom";
  durationInput.disabled = durationFullInput.checked;
  durationInput.value = clampInteger(video.durationSeconds, 1, 86400, 4);
  colorSpaceInput.value = video.colorSpace === "aces2065" ? "aces2065" : "srgb";
  sourceSizeInput.checked = outputSize.mode !== "custom";
  widthInput.value = clampInteger(outputSize.width, 1, 16384, 1920);
  heightInput.value = clampInteger(outputSize.height, 1, 16384, 1080);
  updateResolutionInputs();
  setMode(settings.mode === "video" ? "video" : "png", false);
}

async function addFiles(fileListLike) {
  if (!state.outputDir) {
    showToast("Сначала выберите папку вывода.");
    updateDropzoneState();
    return;
  }

  const files = Array.from(fileListLike || [])
    .map((file) => ({
      id: crypto.randomUUID(),
      path: window.gfxConv.getFilePath(file),
      name: file.name,
      status: "queued",
      progress: 0,
      previewUrl: ""
    }))
    .filter((file) => file.path);

  if (files.length === 0) {
    showToast("Не удалось добавить читаемые файлы.");
    return;
  }

  state.items.push(...files);
  renderFileList();
  hydratePreviews(files);
}

async function hydratePreviews(files) {
  for (const file of files) {
    try {
      const previewUrl = await window.gfxConv.createPreview({ id: file.id, path: file.path });
      const item = findItem(file.id);

      if (item && previewUrl) {
        item.previewUrl = previewUrl;
        renderFileList();
      }
    } catch (_error) {
      const item = findItem(file.id);

      if (item) {
        item.previewError = true;
      }
    }
  }
}

async function startQueue() {
  if (!state.outputDir) {
    showToast("Сначала выберите папку вывода.");
    return;
  }

  if (state.running) {
    state.paused = false;
    renderFileList();
    return;
  }

  if (!state.items.some((item) => item.status === "queued" || item.status === "paused")) {
    showToast("Очередь пуста.");
    return;
  }

  state.running = true;
  state.paused = false;
  state.stopping = false;
  renderFileList();

  while (state.running && !state.paused && !state.stopping) {
    const item = state.items.find((entry) => entry.status === "queued" || entry.status === "paused");

    if (!item) {
      break;
    }

    state.activeId = item.id;
    item.status = "converting";
    item.progress = item.progress || 0;
    renderFileList();

    try {
      const result = await window.gfxConv.convertFile({
        mode: state.mode,
        outputDir: state.outputDir,
        file: item,
        settings: getSettings()
      });
      Object.assign(item, result);
    } catch (error) {
      item.status = state.stopping ? "stopped" : "error";
      item.error = error.message || "Конвертация не удалась.";
    } finally {
      state.activeId = null;
      renderFileList();
    }
  }

  if (state.paused) {
    state.items
      .filter((item) => item.status === "queued")
      .forEach((item) => {
        item.status = "paused";
      });
  }

  state.running = false;
  state.stopping = false;
  renderFileList();
}

function pauseQueue() {
  if (!state.running) {
    return;
  }

  state.paused = true;
  showToast("Очередь остановится после текущего файла.");
  renderFileList();
}

async function stopQueue() {
  if (!state.running && !state.activeId) {
    state.items
      .filter((item) => item.status === "queued" || item.status === "paused")
      .forEach((item) => {
        item.status = "stopped";
      });
    renderFileList();
    return;
  }

  state.stopping = true;
  state.paused = false;
  await window.gfxConv.cancelConversion();
  state.items
    .filter((item) => item.status === "queued" || item.status === "paused")
    .forEach((item) => {
      item.status = "stopped";
    });
  renderFileList();
}

async function clearQueue() {
  if (state.activeId) {
    state.stopping = true;
    await window.gfxConv.cancelConversion();
  }

  state.items = [];
  state.running = false;
  state.paused = false;
  state.stopping = false;
  state.activeId = null;
  renderFileList();
}

function getSettings() {
  return {
    durationMode: durationFullInput.checked ? "full" : "custom",
    durationSeconds: durationInput.value,
    colorSpace: colorSpaceInput.value === "aces2065" ? "aces2065" : "srgb",
    outputSize: {
      mode: sourceSizeInput.checked ? "source" : "custom",
      width: widthInput.value,
      height: heightInput.value
    }
  };
}

function setMode(mode, persist) {
  state.mode = mode === "video" ? "video" : "png";
  modeButtons.forEach((item) => item.classList.toggle("active", item.dataset.mode === state.mode));
  videoSettings.classList.toggle("hidden", state.mode !== "video");
  updateOutputSpec();

  if (persist) {
    saveCurrentSettings();
  }
}

function updateOutputSpec() {
  if (state.mode !== "video") {
    return;
  }

  outputSpec.textContent = colorSpaceInput.value === "aces2065"
    ? "Lossless H.264 High10 · ACES2065-1 color"
    : "Lossless H.264 High10 · sRGB color";
}

function updateResolutionInputs() {
  const disabled = sourceSizeInput.checked;
  widthInput.disabled = disabled;
  heightInput.disabled = disabled;
}

async function saveCurrentSettings() {
  try {
    await window.gfxConv.saveSettings({
      mode: state.mode,
      outputDir: state.outputDir,
      video: getSettings()
    });
  } catch (error) {
    showToast(error.message || "Настройки не сохранены.");
  }
}

function updateDropzoneState() {
  const ready = Boolean(state.outputDir);
  dropzone.classList.toggle("disabled", !ready);
  filePicker.disabled = !ready;
  dropTitle.textContent = ready ? "Перетащите файлы или EXR-папки сюда" : "Сначала выберите папку вывода";
  dropSubtitle.textContent = ready
    ? "Элементы добавятся в очередь; нажмите Старт для конвертации"
    : "Файлы нельзя добавить, пока не выбрана папка вывода";
}

function renderFileList() {
  queueSummary.textContent = buildQueueSummary();
  renderButtons();

  if (state.items.length === 0) {
    fileList.innerHTML = `<li class="empty-queue">В очереди нет элементов</li>`;
    return;
  }

  fileList.innerHTML = state.items.map((file) => {
    const detail = file.error || file.outputPath || file.path;
    const progress = Number.isFinite(file.progress) ? file.progress : 0;
    const preview = file.previewUrl
      ? `<img class="preview" src="${escapeHtml(file.previewUrl)}" alt="">`
      : `<div class="preview placeholder">ПРЕВЬЮ</div>`;
    const action = file.outputPath
      ? `<button type="button" data-open="${escapeHtml(file.outputPath)}">Открыть</button>`
      : "";
    const requeueAction = `<button type="button" data-requeue="${escapeHtml(file.id)}">Повторить</button>`;
    const statusLabel = STATUS_LABELS[file.status] || file.status;

    return `
      <li class="file-item">
        ${preview}
        <div class="file-main">
          <div class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name || file.path)}</div>
          <div class="file-detail" title="${escapeHtml(detail || "")}">${escapeHtml(detail || "")}</div>
          <div class="progress-row">
            <div class="progress-track">
              <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
            <span>${progress}%</span>
          </div>
        </div>
        <span class="pill ${escapeHtml(file.status)}">${escapeHtml(statusLabel)}</span>
        <div class="item-actions">
          ${action}
          ${requeueAction}
        </div>
      </li>
    `;
  }).join("");

  fileList.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", () => {
      window.gfxConv.openPath(button.dataset.open);
    });
  });

  fileList.querySelectorAll("[data-requeue]").forEach((button) => {
    button.addEventListener("click", () => {
      requeueItem(button.dataset.requeue);
    });
  });
}

function requeueItem(id) {
  const item = findItem(id);

  if (!item) {
    return;
  }

  const nextItem = {
    id: crypto.randomUUID(),
    path: item.path,
    name: item.name,
    status: "queued",
    progress: 0,
    previewUrl: item.previewUrl || ""
  };

  state.items.push(nextItem);
  renderFileList();

  if (!nextItem.previewUrl) {
    hydratePreviews([nextItem]);
  }
}

function renderButtons() {
  const hasItems = state.items.length > 0;
  const hasRunnable = state.items.some((item) => item.status === "queued" || item.status === "paused");
  startQueueButton.disabled = !state.outputDir || !hasRunnable || (state.running && !state.paused);
  pauseQueueButton.disabled = !state.running || state.paused;
  stopQueueButton.disabled = !hasItems || (!state.running && !state.activeId && !state.items.some((item) => item.status === "queued" || item.status === "paused"));
  clearQueueButton.disabled = !hasItems;
}

function buildQueueSummary() {
  if (state.items.length === 0) {
    return "0 элементов";
  }

  const done = state.items.filter((item) => item.status === "done").length;
  const active = state.items.some((item) => item.status === "converting") ? " · идёт конвертация" : "";
  const paused = state.paused ? " · пауза после текущего файла" : "";
  return `${done}/${state.items.length} готово${active}${paused}`;
}

async function checkUpdates(showNoUpdate) {
  updateButton.disabled = true;

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
      showUpdateModal(result);
      return;
    }

    if (showNoUpdate) {
      showToast("Установлена последняя версия.");
    }
  } finally {
    updateButton.disabled = false;
  }
}

function showUpdateModal(result) {
  updateTitle.textContent = `Доступна версия ${result.releaseName || result.latestVersion}`;
  updateBody.textContent = `Текущая версия: ${result.currentVersion}. Новая версия: ${result.latestVersion}. Установщик скачается, установится в тихом режиме и перезапустит приложение.`;
  updateProgressWrap.classList.add("hidden");
  updateProgressFill.style.width = "0%";
  updateProgressText.textContent = "0%";
  downloadUpdateButton.disabled = false;
  updateModal.classList.remove("hidden");
  updateModal.setAttribute("aria-hidden", "false");
}

function hideUpdateModal() {
  updateModal.classList.add("hidden");
  updateModal.setAttribute("aria-hidden", "true");
}

async function downloadAndInstallUpdate() {
  if (!pendingUpdate) {
    return;
  }

  downloadUpdateButton.disabled = true;
  closeUpdateModalButton.disabled = true;
  updateBody.textContent = "Скачиваю обновление...";
  updateProgressWrap.classList.remove("hidden");

  try {
    await window.gfxConv.downloadAndInstallUpdate();
  } catch (error) {
    downloadUpdateButton.disabled = false;
    closeUpdateModalButton.disabled = false;
    showToast(error.message || "Не удалось установить обновление.");
  }
}

function showFaqModal() {
  faqModal.classList.remove("hidden");
  faqModal.setAttribute("aria-hidden", "false");
}

function hideFaqModal() {
  faqModal.classList.add("hidden");
  faqModal.setAttribute("aria-hidden", "true");
}

function findItem(id) {
  return state.items.find((item) => item.id === id);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");

  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 4200);
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);

  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
