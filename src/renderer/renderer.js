const state = {
  mode: "png",
  outputDir: "",
  items: [],
  running: false,
  paused: false,
  stopping: false,
  activeId: null
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
const durationInput = document.querySelector("#durationInput");
const align16Input = document.querySelector("#align16Input");
const qualityInput = document.querySelector("#qualityInput");
const encoderInput = document.querySelector("#encoderInput");
const openOutputButton = document.querySelector("#openOutput");
const startQueueButton = document.querySelector("#startQueue");
const pauseQueueButton = document.querySelector("#pauseQueue");
const stopQueueButton = document.querySelector("#stopQueue");
const clearQueueButton = document.querySelector("#clearQueue");
const toast = document.querySelector("#toast");
const versionLabel = document.querySelector("#versionLabel");
const updateButton = document.querySelector("#updateButton");
const updateModal = document.querySelector("#updateModal");
const updateTitle = document.querySelector("#updateTitle");
const updateBody = document.querySelector("#updateBody");
const updateProgressWrap = document.querySelector("#updateProgressWrap");
const updateProgressFill = document.querySelector("#updateProgressFill");
const updateProgressText = document.querySelector("#updateProgressText");
const downloadUpdateButton = document.querySelector("#downloadUpdate");
const closeUpdateModalButton = document.querySelector("#closeUpdateModal");

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
      showToast("Choose an output folder first.");
      return;
    }

    window.gfxConv.openPath(state.outputDir);
  });

  updateButton.addEventListener("click", () => checkUpdates(true));
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

  durationInput.addEventListener("change", () => {
    durationInput.value = clampInteger(durationInput.value, 4, 15, 4);
    saveCurrentSettings();
  });
  align16Input.addEventListener("change", saveCurrentSettings);
  qualityInput.addEventListener("change", saveCurrentSettings);
  encoderInput.addEventListener("change", saveCurrentSettings);
}

async function hydrateVersion() {
  const version = await window.gfxConv.getVersion();
  versionLabel.textContent = `v${version}`;
}

async function hydrateSettings() {
  const settings = await window.gfxConv.getSettings();
  const video = settings.video || {};

  state.outputDir = settings.outputDir || "";
  outputDirInput.value = state.outputDir;
  durationInput.value = clampInteger(video.durationSeconds, 4, 15, 4);
  align16Input.checked = video.align16 !== false;
  qualityInput.value = video.quality === "lossless" ? "lossless" : "visual";
  encoderInput.value = "cpu";
  setMode(settings.mode === "video" ? "video" : "png", false);
}

async function addFiles(fileListLike) {
  if (!state.outputDir) {
    showToast("Choose output folder first.");
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
    showToast("No readable files were added.");
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
    showToast("Choose output folder first.");
    return;
  }

  if (state.running) {
    state.paused = false;
    renderFileList();
    return;
  }

  if (!state.items.some((item) => item.status === "queued" || item.status === "paused")) {
    showToast("Queue is empty.");
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
      item.error = error.message || "Conversion failed.";
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
  showToast("Queue will pause after the current item.");
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
    durationSeconds: durationInput.value,
    align16: align16Input.checked,
    quality: qualityInput.value === "lossless" ? "lossless" : "visual",
    encoder: "cpu"
  };
}

function setMode(mode, persist) {
  state.mode = mode === "video" ? "video" : "png";
  modeButtons.forEach((item) => item.classList.toggle("active", item.dataset.mode === state.mode));
  videoSettings.classList.toggle("hidden", state.mode !== "video");

  if (persist) {
    saveCurrentSettings();
  }
}

async function saveCurrentSettings() {
  try {
    await window.gfxConv.saveSettings({
      mode: state.mode,
      outputDir: state.outputDir,
      video: getSettings()
    });
  } catch (error) {
    showToast(error.message || "Settings were not saved.");
  }
}

function updateDropzoneState() {
  const ready = Boolean(state.outputDir);
  dropzone.classList.toggle("disabled", !ready);
  filePicker.disabled = !ready;
  dropTitle.textContent = ready ? "Drop files or EXR folders here" : "Choose output folder first";
  dropSubtitle.textContent = ready
    ? "Items are added to the queue; press Start to convert"
    : "Files cannot be added until an output folder is selected";
}

function renderFileList() {
  queueSummary.textContent = buildQueueSummary();
  renderButtons();

  if (state.items.length === 0) {
    fileList.innerHTML = `<li class="empty-queue">No items in queue</li>`;
    return;
  }

  fileList.innerHTML = state.items.map((file) => {
    const detail = file.error || file.outputPath || file.path;
    const progress = Number.isFinite(file.progress) ? file.progress : 0;
    const preview = file.previewUrl
      ? `<img class="preview" src="${escapeHtml(file.previewUrl)}" alt="">`
      : `<div class="preview placeholder">PREV</div>`;
    const action = file.outputPath
      ? `<button type="button" data-open="${escapeHtml(file.outputPath)}">Open</button>`
      : "";

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
        <span class="pill ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>
        ${action}
      </li>
    `;
  }).join("");

  fileList.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", () => {
      window.gfxConv.openPath(button.dataset.open);
    });
  });
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
    return "0 items";
  }

  const done = state.items.filter((item) => item.status === "done").length;
  const active = state.items.some((item) => item.status === "converting") ? " · converting" : "";
  const paused = state.paused ? " · pause pending" : "";
  return `${done}/${state.items.length} done${active}${paused}`;
}

async function checkUpdates(showNoUpdate) {
  updateButton.disabled = true;

  try {
    const result = await window.gfxConv.checkUpdates();

    if (!result.ok) {
      if (showNoUpdate) {
        showToast(`Update check failed: ${result.error}`);
      }
      return;
    }

    if (result.hasUpdate && result.installerAsset) {
      pendingUpdate = result;
      showUpdateModal(result);
      return;
    }

    if (showNoUpdate) {
      showToast("You are on the latest version.");
    }
  } finally {
    updateButton.disabled = false;
  }
}

function showUpdateModal(result) {
  updateTitle.textContent = `${result.releaseName || result.latestVersion} is available`;
  updateBody.textContent = `Current version: ${result.currentVersion}. New version: ${result.latestVersion}. The installer will be downloaded and launched locally.`;
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
  updateProgressWrap.classList.remove("hidden");

  try {
    await window.gfxConv.downloadAndInstallUpdate();
  } catch (error) {
    downloadUpdateButton.disabled = false;
    showToast(error.message || "Update install failed.");
  }
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
