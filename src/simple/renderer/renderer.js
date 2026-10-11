"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.simpleConv;
  const defaults = {
    direction: "ai", outputDir: "", inputColorSpace: "", inputMatrix: "auto", inputRange: "auto", inputFps: 24,
    outputFps: "", width: "", height: "", rangeStart: "", rangeEnd: "",
    exportKind: "video", frameIndex: 0, conversion: "preserve",
    flattenAlpha: false, sourceManifest: "",
  };
  const state = {
    settings: { ...defaults }, colors: [], defaultSpace: "", ready: false, initialized: false,
    jobs: [], selectedId: null, analyzing: false, choosing: false, processing: false, activeId: null,
    pauseRequested: false, stopRequested: false, stopping: false, clearAfterStop: false, cancelPending: null,
    candidates: null, previewVersion: 0, previewBusy: false, previewPending: false,
    previewTimer: null, saveTimer: null, savePending: null, saveBusy: false,
    update: null, checkingUpdate: false, installing: false, unsubscribers: [],
  };
  const statusLabels = {
    pending: "В очереди", running: "В работе", done: "Готово",
    failed: "Ошибка", cancelled: "Остановлено", blocked: "Проверка",
  };
  const phaseLabels = {
    copy: "Копирование…", conversion: "Конвертация…", verify: "Проверка результата…",
    done: "Готово", download: "Загрузка обновления…", install: "Установка обновления…",
    encode: "Экспорт…", complete: "Готово", completed: "Готово", ready: "Готово",
    installed: "Обновление установлено", error: "Ошибка", failed: "Ошибка",
    cancelled: "Отменено", canceled: "Отменено",
  };
  const settingsInputs = {
    inputColorSpace: "input-color", inputMatrix: "input-matrix", inputRange: "input-range", inputFps: "input-fps", outputFps: "output-fps",
    width: "width", height: "height", rangeStart: "range-start", rangeEnd: "range-end",
    exportKind: "export-kind", frameIndex: "frame-index", conversion: "conversion",
  };
  const videoSettingLabels = {
    inputMatrix: { auto: "Авто", bt709: "BT.709", bt601: "BT.601", bt2020: "BT.2020" },
    inputRange: { auto: "Авто", tv: "Ограниченный", pc: "Полный" },
  };
  const numericSettings = new Set(["inputFps", "outputFps", "width", "height", "rangeStart", "rangeEnd", "frameIndex"]);
  const clone = (value) => structuredClone(value);
  const selectedJob = () => state.jobs.find((job) => job.id === state.selectedId);
  const isExr = (source) => /\.exr$/i.test(source.path || "") || source.files?.some((path) => /\.exr$/i.test(path));
  const needsAlphaFlatten = (job) => job.settings.direction === "ai" && job.settings.exportKind === "video" && job.source.hasAlpha;
  const progressText = (progress, fallback) => /[А-Яа-яЁё]/.test(progress.message || "") ? progress.message : (phaseLabels[progress.phase] || fallback);
  const messageOf = (error) => error?.message || String(error || "Неизвестная ошибка");
  const numberText = (value) => Number.isFinite(Number(value)) && value !== null && value !== "" && value !== undefined ? String(Math.round(Number(value) * 1000) / 1000) : "?";

  function icons() {
    window.lucide?.createIcons({ attrs: { "aria-hidden": "true", "stroke-width": 1.7 } });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showMessage(id, text) {
    $(id).textContent = text || "";
    $(id).hidden = !text;
  }

  function notice(text) { showMessage("notice", text); }

  function iconButton(icon, title, action, disabled = false) {
    const button = el("button", "icon-button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.disabled = disabled;
    const graphic = el("i");
    graphic.dataset.lucide = icon;
    button.append(graphic);
    button.addEventListener("click", (event) => { event.stopPropagation(); action(); });
    return button;
  }

  async function guarded(action) {
    try { return await action(); }
    catch (error) { notice(messageOf(error)); return undefined; }
  }

  async function choose(method) {
    if (state.choosing) return null;
    state.choosing = true;
    updateControls();
    try { return await api[method](); }
    finally { state.choosing = false; updateControls(); }
  }

  function settingsError(settings) {
    const nuke = settings.direction === "nuke";
    for (const [key, labels] of Object.entries(videoSettingLabels)) {
      if (!Object.hasOwn(labels, settings[key])) return "Проверьте матрицу YUV и диапазон уровней видео.";
    }
    if (!Number.isFinite(Number(settings.inputFps)) || Number(settings.inputFps) <= 0) return "FPS источника EXR должен быть больше 0.";
    if (!nuke) {
      for (const key of ["outputFps", "width", "height", "rangeStart", "rangeEnd"]) {
        const value = settings[key];
        if (value === "") continue;
        if (!Number.isFinite(Number(value)) || Number(value) < 0 || (["outputFps", "width", "height"].includes(key) && Number(value) === 0)) return "Проверьте числовые настройки: допустимы положительные значения, границы диапазона — от 0.";
        if (["width", "height"].includes(key) && !Number.isInteger(Number(value))) return "Размеры задаются целым числом пикселей.";
      }
      if (settings.rangeEnd !== "" && settings.rangeStart !== "" && Number(settings.rangeEnd) <= Number(settings.rangeStart)) return "Конец диапазона должен быть позже начала.";
      if (settings.exportKind === "png" && (!Number.isInteger(Number(settings.frameIndex)) || Number(settings.frameIndex) < 0)) return "Индекс кадра должен быть целым числом от 0.";
    }
    return "";
  }

  function jobBlock(job) {
    if (job.source.error) return job.source.error;
    if (job.source.gaps?.length) return "В последовательности есть пропущенные кадры.";
    if (!job.settings.outputDir) return "Не выбрана папка результата.";
    if (!state.colors.includes(job.settings.inputColorSpace)) return "Выберите пространство из конфигурации OCIO.";
    if (job.needsConfirmation && !job.colorConfirmed) return "Подтвердите цветовое пространство источника.";
    if (needsAlphaFlatten(job) && !job.settings.flattenAlpha) return "Подтвердите сведение альфы на чёрный фон.";
    const frameCount = job.source.frameCount ?? (job.source.kind === "image" ? 1 : undefined);
    if (job.settings.exportKind === "png" && (job.settings.frameIndex < 0 || !Number.isInteger(job.settings.frameIndex) || (Number(frameCount) > 0 && job.settings.frameIndex >= Number(frameCount)))) return "Индекс кадра выходит за пределы источника.";
    const usesInputFps = isExr(job.source) || (job.settings.direction === "nuke" && job.source.kind !== "video");
    return settingsError(usesInputFps ? job.settings : { ...job.settings, inputFps: defaults.inputFps });
  }

  function updateControls() {
    const locked = !state.initialized || !state.ready || state.analyzing || state.choosing || state.installing || !!state.candidates;
    for (const id of ["files-button", "folder-button", "output-button", "mode-ai", "mode-nuke"]) $(id).disabled = locked;
    $("drop-zone").setAttribute("aria-disabled", String(locked));
    const nuke = state.settings.direction === "nuke";
    for (const [key, id] of Object.entries(settingsInputs)) {
      const notApplicable = nuke && ["outputFps", "width", "height", "rangeStart", "rangeEnd", "exportKind", "frameIndex"].includes(key);
      $(id).disabled = locked || notApplicable || (key === "frameIndex" && state.settings.exportKind !== "png");
      $(id).title = notApplicable ? "При возврате в Nuke сохраняются параметры источника" : "";
    }
    $("manifest-button").disabled = locked || !nuke;
    $("manifest-clear").disabled = locked || !nuke || !state.settings.sourceManifest;
    $("mode-ai").setAttribute("aria-pressed", String(!nuke));
    $("mode-nuke").setAttribute("aria-pressed", String(nuke));
    $("conversion-field").hidden = !nuke;
    $("export-field").hidden = nuke;
    $("frame-field").hidden = nuke;
    $("manifest").closest(".manifest-field").hidden = !nuke;
    $("pause-button").disabled = !state.processing || state.stopping;
    $("pause-button").setAttribute("aria-pressed", String(state.pauseRequested));
    $("stop-button").disabled = !state.processing || state.stopping;
    $("start-button").disabled = !state.ready || state.processing || state.analyzing || state.choosing || state.installing || !state.jobs.some((job) => job.status === "pending" && !jobBlock(job));
    $("start-button").querySelector("span").textContent = state.pauseRequested ? "Продолжить" : "Начать";
    $("clear-button").disabled = !state.jobs.length || state.stopping;
    const job = selectedJob();
    $("preview-button").disabled = !state.ready || !job || state.previewBusy;
    $("update-button").disabled = !state.initialized || state.checkingUpdate;
    $("logs-button").disabled = !state.initialized;
    $("update-install").disabled = !state.update?.available || state.installing || state.processing || state.analyzing || state.choosing || !!state.candidates;
    const pending = state.jobs.filter((item) => item.status === "pending");
    const done = state.jobs.filter((item) => item.status === "done").length;
    $("queue-status").textContent = state.stopping ? "Остановка…" : state.processing ? (state.pauseRequested ? "Пауза после текущего" : "Конвертация…") : state.pauseRequested ? "На паузе" : pending.some(jobBlock) ? "Нужны подтверждения" : state.jobs.length ? `Готово ${done} / ${state.jobs.length}` : "Готово";
    $("queue-count").textContent = String(state.jobs.length);
    showMessage("settings-error", settingsError(state.settings));
  }

  function reflectSettings() {
    for (const [key, id] of Object.entries(settingsInputs)) $(id).value = state.settings[key];
    $("output-dir").value = state.settings.outputDir;
    $("output-dir").title = state.settings.outputDir;
    $("manifest").value = state.settings.sourceManifest;
    $("manifest").title = state.settings.sourceManifest;
    updateControls();
  }

  // Serialize saves so an older IPC response cannot overwrite a newer preference.
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    if (settingsError(state.settings)) return;
    state.savePending = clone(state.settings);
    state.saveTimer = setTimeout(flushSave, 180);
  }

  async function flushSave() {
    if (state.saveBusy || !state.savePending || !state.initialized) return;
    state.saveBusy = true;
    const settings = state.savePending;
    state.savePending = null;
    try { await api.saveSettings(settings); }
    catch (error) { notice(`Не удалось сохранить настройки: ${messageOf(error)}`); }
    finally {
      state.saveBusy = false;
      if (state.savePending) flushSave();
    }
  }

  function changeSetting(key, value) {
    state.settings = { ...state.settings, [key]: value };
    reflectSettings();
    scheduleSave();
  }

  function sourceMeta(source, settings) {
    const kind = { sequence: "Последовательность", image: "Изображение", video: "Видео" }[source.kind] || source.kind;
    const fps = isExr(source) || (settings.direction === "nuke" && source.kind !== "video") ? settings.inputFps : source.fps;
    return `${kind} · ${numberText(source.width)} × ${numberText(source.height)} · ${numberText(fps)} FPS${source.frameCount ? ` · ${source.frameCount} кадр.` : ""}`;
  }

  function renderQueue() {
    const queue = $("queue");
    queue.replaceChildren();
    if (!state.jobs.length) queue.append(el("div", "empty", "Нет заданий"));
    for (const job of state.jobs) {
      const item = el("div", `job${job.id === state.selectedId ? " selected" : ""}`);
      item.tabIndex = 0;
      item.setAttribute("role", "group");
      item.setAttribute("aria-label", `${job.source.name || job.source.path}, ${statusLabels[job.status]}`);
      item.dataset.jobId = job.id;
      item.addEventListener("click", () => selectJob(job.id));
      item.addEventListener("keydown", (event) => {
        if (event.target === item && ["Enter", " "].includes(event.key)) { event.preventDefault(); selectJob(job.id); }
      });
      const top = el("div", "job-top");
      const blocked = job.status === "pending" && jobBlock(job);
      top.append(el("span", "job-name", job.source.name || job.source.path), el("span", `job-state ${blocked ? "blocked" : job.status}`, blocked ? "Проверка" : statusLabels[job.status]));
      item.append(top, el("div", "job-meta", `${job.settings.direction === "ai" ? "Для AI" : "В Nuke"} · ${sourceMeta(job.source, job.settings)}`));
      const bottom = el("div", "job-bottom");
      bottom.append(el("span", "muted", job.message || blocked || job.settings.inputColorSpace));
      const actions = el("div", "job-actions");
      if (["done", "failed", "cancelled"].includes(job.status)) actions.append(iconButton("rotate-ccw", "Повторить задание", () => retry(job.id), state.processing || state.analyzing || state.choosing || state.installing));
      if (job.result?.outputPath) actions.append(iconButton("folder-open", "Открыть папку результата", () => guarded(() => api.openPath(parentPath(job.result.outputPath)))));
      actions.append(iconButton("x", "Убрать задание из очереди", () => removeJob(job.id), state.processing));
      bottom.append(actions);
      item.append(bottom);
      if (job.status === "running" || job.status === "done") {
        const progress = el("progress");
        progress.max = 100;
        progress.value = job.status === "done" ? 100 : job.percent;
        progress.setAttribute("aria-label", `Прогресс ${job.source.name || "задания"}`);
        item.append(progress);
      }
      queue.append(item);
    }
    icons();
    updateControls();
  }

  function parentPath(path) {
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return separator >= 0 ? path.slice(0, separator + 1) : path;
  }

  function checkbox(label, checked, disabled, action) {
    const wrapper = el("label", "check-label");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener("change", () => action(input.checked));
    wrapper.append(input, el("span", "", label));
    return wrapper;
  }

  function renderDetails() {
    const panel = $("job-details");
    panel.replaceChildren();
    const job = selectedJob();
    if (!job) return;
    const locked = state.processing || job.status === "done";
    panel.append(el("div", "detail-line", job.source.path));
    panel.append(el("div", "detail-line", `Результат: ${job.settings.outputDir}`));
    const colorLabel = el("label", "job-color", "Цвет этого источника");
    const select = el("select");
    select.setAttribute("aria-label", "Цвет этого источника");
    select.disabled = locked;
    if (!state.colors.includes(job.settings.inputColorSpace)) select.append(new Option("Выберите пространство", ""));
    for (const space of state.colors) select.append(new Option(space, space));
    select.value = job.settings.inputColorSpace;
    select.addEventListener("change", () => {
      job.settings = Object.freeze({ ...job.settings, inputColorSpace: select.value });
      job.needsConfirmation = true;
      job.colorConfirmed = false;
      renderQueue();
      renderDetails();
      schedulePreview();
    });
    colorLabel.append(select);
    panel.append(colorLabel);
    if (job.needsConfirmation) {
      panel.append(el("div", "warning", job.source.kind === "video" && job.source.hdr ? "Источник HDR. Выберите и подтвердите цветовое пространство; SDR автоматически не назначается." : "Цвет источника не подтверждён метаданными. Проверьте выбранное пространство."));
      panel.append(checkbox("Подтверждаю цветовое пространство этого источника", job.colorConfirmed, locked || !select.value, (checked) => {
        job.colorConfirmed = checked;
        renderQueue();
      }));
    }
    if (needsAlphaFlatten(job)) {
      panel.append(el("div", "warning", "Обнаружена альфа. Прозрачность будет сведена на чёрный фон."));
      panel.append(checkbox("Разрешаю свести альфу на чёрный фон", job.settings.flattenAlpha, locked, (checked) => {
        job.settings = Object.freeze({ ...job.settings, flattenAlpha: checked });
        renderQueue();
        schedulePreview();
      }));
    } else if (job.source.hasAlpha && job.settings.exportKind === "png") {
      panel.append(el("div", "detail-line", "Альфа сохраняется в PNG."));
    }
    const details = [];
    if (job.settings.direction === "nuke") details.push(job.settings.conversion === "exr" ? "Возврат: EXR + .nk" : "Возврат: исходный формат + .nk");
    else details.push(job.settings.exportKind === "png" ? `PNG · кадр ${job.settings.frameIndex}` : "Видео");
    if (job.settings.outputFps !== "") details.push(`${job.settings.outputFps} FPS результата`);
    if (job.settings.width !== "" || job.settings.height !== "") details.push(`${job.settings.width || "исходная"} × ${job.settings.height || "исходная"}`);
    if (job.settings.rangeStart !== "" || job.settings.rangeEnd !== "") details.push(`${job.settings.rangeStart || 0}–${job.settings.rangeEnd === "" ? "конец" : job.settings.rangeEnd} с`);
    panel.append(el("div", "detail-line", details.join(" · ")));
    if (job.source.kind === "video") panel.append(el("div", "detail-line", `Матрица YUV: ${videoSettingLabels.inputMatrix[job.settings.inputMatrix]} · Диапазон уровней: ${videoSettingLabels.inputRange[job.settings.inputRange]}`));
    if (job.settings.sourceManifest) panel.append(el("div", "detail-line", `Манифест: ${job.settings.sourceManifest}`));
    for (const warning of new Set([...(job.source.warnings || []), ...(job.result?.warnings || [])])) panel.append(el("div", "warning", warning));
    if (job.error) panel.append(el("div", "error", job.error));
    if (job.result) {
      panel.append(el("div", "detail-line", `Файл: ${job.result.outputPath}`));
      if (job.result.manifestPath) panel.append(el("div", "detail-line", `Манифест: ${job.result.manifestPath}`));
      if (job.result.nukePath) panel.append(el("div", "detail-line", `Nuke: ${job.result.nukePath}`));
      if (job.result.method) panel.append(el("div", "detail-line", phaseLabels[job.result.method] || "Экспорт завершён"));
    }
  }

  function selectJob(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    renderQueue();
    renderDetails();
    schedulePreview();
  }

  function schedulePreview() {
    state.previewVersion += 1;
    clearTimeout(state.previewTimer);
    $("preview-image").hidden = true;
    $("preview-image").removeAttribute("src");
    $("preview-placeholder").hidden = false;
    $("preview-placeholder").textContent = selectedJob() ? "Загрузка кадра…" : "Источник не выбран";
    $("preview-caption").textContent = "";
    showMessage("preview-error", "");
    state.previewTimer = setTimeout(requestPreview, 200);
  }

  // One preview request at a time, with a latest-selection guard after every await.
  async function requestPreview() {
    const job = selectedJob();
    if (!job || !state.ready) return;
    if (state.previewBusy) { state.previewPending = true; return; }
    const version = state.previewVersion;
    state.previewBusy = true;
    state.previewPending = false;
    updateControls();
    try {
      const result = await api.preview({ source: clone(job.source), settings: clone(job.settings) });
      if (version !== state.previewVersion || selectedJob()?.id !== job.id) return;
      if (!result?.url) throw new Error("Backend не вернул изображение предпросмотра.");
      const image = $("preview-image");
      image.onload = () => {
        if (version !== state.previewVersion) return;
        image.hidden = false;
        $("preview-placeholder").hidden = true;
      };
      image.onerror = () => {
        if (version !== state.previewVersion) return;
        image.hidden = true;
        $("preview-placeholder").hidden = false;
        $("preview-placeholder").textContent = "Нет предпросмотра";
        showMessage("preview-error", "Не удалось загрузить изображение backend.");
      };
      image.src = result.url;
      $("preview-caption").textContent = `${job.source.name || "Источник"} · ${numberText(result.width)} × ${numberText(result.height)}`;
    } catch (error) {
      if (version === state.previewVersion) {
        $("preview-placeholder").textContent = "Нет предпросмотра";
        showMessage("preview-error", messageOf(error));
      }
    } finally {
      state.previewBusy = false;
      updateControls();
      if (state.previewPending || version !== state.previewVersion) {
        state.previewPending = false;
        clearTimeout(state.previewTimer);
        state.previewTimer = setTimeout(requestPreview, 200);
      }
    }
  }

  function sourceKey(source) {
    return JSON.stringify([source.kind, source.path, source.startFrame, source.endFrame, source.files || []]);
  }

  function makeJob(source, base) {
    const spaces = state.colors;
    const hdrVideo = source.kind === "video" && !!source.hdr;
    const explicit = spaces.includes(base.inputColorSpace) ? base.inputColorSpace : "";
    const known = !hdrVideo && spaces.includes(source.colorSpace) ? source.colorSpace : "";
    const suggested = !hdrVideo && spaces.includes(source.suggestedColorSpace) ? source.suggestedColorSpace : "";
    const color = explicit || known || suggested || (isExr(source) && spaces.includes(state.defaultSpace) ? state.defaultSpace : "");
    const needsConfirmation = hdrVideo || !!source.needsColorConfirmation || (isExr(source) && !known) || (!known && !suggested) || (explicit && explicit !== (known || suggested));
    const nuke = base.direction === "nuke";
    const settings = {
      ...clone(base), inputColorSpace: color,
      inputMatrix: source.kind === "video" ? base.inputMatrix : "auto",
      inputRange: source.kind === "video" ? base.inputRange : "auto",
      inputFps: isExr(source) ? base.inputFps : "",
      exportKind: !nuke ? base.exportKind : "video",
      frameIndex: !nuke && base.exportKind === "png" ? Number(base.frameIndex) : 0,
      conversion: nuke ? base.conversion : "preserve",
      flattenAlpha: false, sourceManifest: nuke ? base.sourceManifest : "",
    };
    if (nuke) {
      settings.outputFps = "";
      settings.width = "";
      settings.height = "";
      settings.rangeStart = "";
      settings.rangeEnd = "";
      settings.inputFps = source.kind !== "video" ? base.inputFps : "";
    }
    return {
      id: crypto.randomUUID(), source: clone(source), settings: Object.freeze(settings),
      needsConfirmation: !!needsConfirmation, colorConfirmed: !needsConfirmation,
      status: "pending", percent: 0, message: "", error: "", result: null,
    };
  }

  function addSources(sources, settings) {
    let added = 0;
    let first;
    for (const source of sources) {
      if (source.error || source.gaps?.length) continue;
      if (state.jobs.some((job) => sourceKey(job.source) === sourceKey(source))) continue;
      const job = makeJob(source, settings);
      state.jobs.push(job);
      first ||= job.id;
      added += 1;
    }
    if (first) {
      state.selectedId = first;
      renderDetails();
      schedulePreview();
    }
    renderQueue();
    if (!added) notice("Новых доступных источников нет: проверьте ошибки или уже добавленные задания.");
  }

  async function analyzePaths(paths) {
    if (!paths?.length || state.analyzing || !state.ready || state.candidates) return;
    const invalid = settingsError(state.settings);
    if (invalid) { notice(invalid); $("advanced").open = true; return; }
    state.analyzing = true;
    updateControls();
    notice("");
    showMessage("analysis-status", "Анализ источников…");
    try {
      if (!state.settings.outputDir) {
        const outputDir = await choose("chooseOutput");
        if (!outputDir) return;
        changeSetting("outputDir", outputDir);
      }
      const settings = clone(state.settings);
      const result = await api.analyze({ paths: [...new Set(paths)] });
      const sources = result?.sources || [];
      const errors = (result?.errors || []).map((error) => `${error.path}: ${error.message}`);
      if (sources.length > 1 && sources.some((source) => source.kind === "sequence")) {
        showCandidates(sources, settings);
      } else {
        for (const source of sources) {
          if (source.error) errors.push(`${source.name || source.path}: ${source.error}`);
          else if (source.gaps?.length) errors.push(`${source.name || source.path}: пропуски кадров ${source.gaps.join(", ")}`);
        }
        addSources(sources, settings);
      }
      if (errors.length) notice(errors.join("\n"));
      if (!sources.length && !errors.length) notice("Поддерживаемые источники не найдены.");
    } catch (error) { notice(`Не удалось добавить источники: ${messageOf(error)}`); }
    finally {
      state.analyzing = false;
      showMessage("analysis-status", "");
      updateControls();
    }
  }

  function showCandidates(sources, settings) {
    state.candidates = { sources, settings };
    const list = $("candidate-list");
    list.replaceChildren();
    sources.forEach((source, index) => {
      const item = el("label", "candidate");
      const check = el("input");
      check.type = "checkbox";
      check.value = String(index);
      check.disabled = !!source.error || !!source.gaps?.length;
      check.checked = !check.disabled;
      check.addEventListener("change", updateCandidateButton);
      const description = el("div");
      description.append(el("div", "candidate-name", source.name || source.path), el("div", "candidate-path", source.path), el("div", "job-meta", sourceMeta(source, settings)));
      if (source.error) description.append(el("div", "error", source.error));
      if (source.gaps?.length) description.append(el("div", "error", `Заблокировано: пропуски кадров ${source.gaps.join(", ")}`));
      for (const warning of source.warnings || []) description.append(el("div", "warning", warning));
      item.append(check, description);
      list.append(item);
    });
    updateCandidateButton();
    $("candidates-dialog").showModal();
    updateControls();
  }

  function updateCandidateButton() {
    $("candidates-add").disabled = !$("candidate-list").querySelector("input:checked:not(:disabled)");
  }

  function closeCandidates() {
    state.candidates = null;
    $("candidates-dialog").close();
    updateControls();
  }

  function retry(id) {
    if (state.processing || state.analyzing || state.choosing || state.installing) return;
    const job = state.jobs.find((item) => item.id === id);
    if (!job || !["done", "failed", "cancelled"].includes(job.status)) return;
    const invalid = settingsError(state.settings);
    if (invalid) { notice(invalid); $("advanced").open = true; return; }
    if (!state.settings.outputDir) { notice("Выберите папку результата перед повтором задания."); return; }
    const next = makeJob(job.source, state.settings);
    state.jobs.push(next);
    state.selectedId = next.id;
    renderQueue();
    renderDetails();
    schedulePreview();
  }

  function removeJob(id) {
    if (state.processing) return;
    state.jobs = state.jobs.filter((job) => job.id !== id);
    if (state.selectedId === id) {
      state.selectedId = state.jobs[0]?.id || null;
      renderDetails();
      schedulePreview();
    }
    renderQueue();
  }

  async function start() {
    if (state.processing || !state.ready) return;
    state.processing = true;
    state.stopRequested = false;
    state.pauseRequested = false;
    state.cancelPending = null;
    notice("");
    renderQueue();
    renderDetails();
    try {
      while (!state.stopRequested && !state.pauseRequested) {
        const job = state.jobs.find((item) => item.status === "pending" && !jobBlock(item));
        if (!job) break;
        state.activeId = job.id;
        job.status = "running";
        job.message = "Запуск…";
        renderQueue();
        renderDetails();
        try {
          job.result = await api.run({ id: job.id, source: clone(job.source), settings: clone(job.settings), colorConfirmed: job.colorConfirmed });
          job.status = "done";
          job.percent = 100;
          job.message = "Готово";
        } catch (error) {
          job.status = state.stopRequested ? "cancelled" : "failed";
          job.error = messageOf(error);
          job.message = job.status === "cancelled" ? "Остановлено" : "Ошибка конвертации";
        } finally {
          state.activeId = null;
          renderQueue();
          renderDetails();
        }
      }
    } finally {
      if (state.cancelPending) await state.cancelPending;
      state.processing = false;
      state.stopping = false;
      if (state.clearAfterStop) {
        state.clearAfterStop = false;
        clearQueue();
      }
      renderQueue();
      renderDetails();
    }
  }

  async function stop(clear = false) {
    if (!state.processing) { if (clear) clearQueue(); return; }
    if (state.stopping) return;
    state.stopRequested = true;
    state.stopping = true;
    state.clearAfterStop = clear;
    updateControls();
    state.cancelPending = Promise.resolve().then(() => api.cancel()).catch((error) => {
      state.clearAfterStop = false;
      state.stopping = false;
      notice(`Не удалось отменить операцию. Очередь сохранена: ${messageOf(error)}`);
      updateControls();
    });
    await state.cancelPending;
  }

  function clearQueue() {
    if (state.processing) return;
    state.jobs = [];
    state.selectedId = null;
    renderQueue();
    renderDetails();
    schedulePreview();
  }

  function onProgress(progress) {
    if (!progress || progress.id !== state.activeId) return;
    const job = state.jobs.find((item) => item.id === progress.id);
    if (!job || job.status !== "running") return;
    if (Number.isFinite(Number(progress.percent))) job.percent = Math.max(0, Math.min(100, Number(progress.percent)));
    job.message = progressText(progress, "Конвертация…");
    if (progress.frame !== undefined && progress.frames !== undefined) job.message += ` · ${progress.frame} / ${progress.frames}`;
    renderQueue();
  }

  async function checkUpdate(silent = false) {
    if (state.checkingUpdate || state.installing) return;
    state.checkingUpdate = true;
    updateControls();
    try {
      const result = await api.checkUpdates();
      if (result.error) throw new Error(result.error);
      state.update = result;
      $("update-button").title = result.available ? `Доступно обновление ${result.version || ""}` : "Проверить обновления";
      $("update-button").setAttribute("aria-label", $("update-button").title);
      $("update-info").textContent = result.available ? `Доступна версия ${result.version || ""}` : "Установлена актуальная версия.";
      $("update-notes").textContent = result.notes || "";
      showMessage("update-status", "");
      if (!silent) $("update-dialog").showModal();
    } catch (error) {
      if (!silent) {
        $("update-info").textContent = "Не удалось проверить обновления.";
        $("update-notes").textContent = "";
        state.update = null;
        showMessage("update-status", messageOf(error));
        $("update-dialog").showModal();
      }
    } finally {
      state.checkingUpdate = false;
      updateControls();
    }
  }

  function bind() {
    $("mode-ai").addEventListener("click", () => changeSetting("direction", "ai"));
    $("mode-nuke").addEventListener("click", () => changeSetting("direction", "nuke"));
    for (const [key, id] of Object.entries(settingsInputs)) {
      $(id).addEventListener("change", () => {
        const value = $(id).value;
        changeSetting(key, numericSettings.has(key) && value !== "" ? Number(value) : value);
      });
    }
    $("output-button").addEventListener("click", () => guarded(async () => {
      const path = await choose("chooseOutput");
      if (path) changeSetting("outputDir", path);
    }));
    $("files-button").addEventListener("click", () => guarded(async () => analyzePaths(await choose("chooseFiles"))));
    $("folder-button").addEventListener("click", () => guarded(async () => {
      const path = await choose("chooseFolder");
      if (path) await analyzePaths([path]);
    }));
    $("manifest-button").addEventListener("click", () => guarded(async () => {
      const path = await choose("chooseManifest");
      if (path) changeSetting("sourceManifest", path);
    }));
    $("manifest-clear").addEventListener("click", () => changeSetting("sourceManifest", ""));
    const dropZone = $("drop-zone");
    let dragDepth = 0;
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
      document.addEventListener(type, (event) => event.preventDefault());
    }
    dropZone.addEventListener("dragenter", () => {
      dragDepth += 1;
      if (dropZone.getAttribute("aria-disabled") === "false") dropZone.classList.add("dragging");
    });
    dropZone.addEventListener("dragleave", () => {
      dragDepth -= 1;
      if (dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("dragging"); }
    });
    dropZone.addEventListener("drop", (event) => {
      dragDepth = 0;
      dropZone.classList.remove("dragging");
      if (dropZone.getAttribute("aria-disabled") !== "false") return;
      guarded(() => {
        const paths = api.pathsForFiles([...event.dataTransfer.files]);
        if (!paths.length) { notice("Не удалось получить пути файлов. Используйте выбор файлов или папки."); return; }
        return analyzePaths(paths);
      });
    });
    dropZone.addEventListener("keydown", (event) => {
      if (event.target === dropZone && event.key === "Enter" && !$("files-button").disabled) $("files-button").click();
    });
    $("candidates-add").addEventListener("click", () => {
      const selected = [...$("candidate-list").querySelectorAll("input:checked:not(:disabled)")].map((check) => state.candidates.sources[Number(check.value)]);
      addSources(selected, state.candidates.settings);
      closeCandidates();
    });
    for (const id of ["candidates-close", "candidates-cancel"]) $(id).addEventListener("click", closeCandidates);
    $("candidates-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeCandidates(); });
    $("start-button").addEventListener("click", start);
    $("pause-button").addEventListener("click", () => {
      state.pauseRequested = !state.pauseRequested;
      updateControls();
    });
    $("stop-button").addEventListener("click", () => stop());
    $("clear-button").addEventListener("click", () => {
      $("clear-description").textContent = state.processing ? "Текущая операция будет остановлена. После её завершения все задания будут убраны из очереди. Файлы результатов останутся на диске." : "Все задания будут убраны из очереди. Файлы результатов останутся на диске.";
      $("clear-dialog").showModal();
    });
    $("clear-cancel").addEventListener("click", () => $("clear-dialog").close());
    $("clear-confirm").addEventListener("click", () => {
      $("clear-dialog").close();
      if (state.processing) stop(true); else clearQueue();
    });
    $("preview-button").addEventListener("click", schedulePreview);
    $("faq-button").addEventListener("click", () => $("faq-dialog").showModal());
    $("faq-close").addEventListener("click", () => $("faq-dialog").close());
    $("logs-button").addEventListener("click", () => guarded(async () => {
      const result = await api.collectLogs();
      notice(result?.path ? `Журнал: ${result.path}` : "Журнал не создан.");
    }));
    $("update-button").addEventListener("click", () => {
      if (state.installing || state.update?.available) $("update-dialog").showModal(); else checkUpdate();
    });
    $("update-close").addEventListener("click", () => $("update-dialog").close());
    $("update-install").addEventListener("click", async () => {
      if ($("update-install").disabled) return;
      state.installing = true;
      updateControls();
      $("update-progress").hidden = false;
      showMessage("update-status", "Подготовка обновления…");
      try { await api.installUpdate(); }
      catch (error) {
        state.installing = false;
        showMessage("update-status", `Обновление не установлено: ${messageOf(error)}`);
        updateControls();
      }
    });
  }

  async function initialize() {
    icons();
    bind();
    updateControls();
    try {
      if (!api) throw new Error("Недоступен интерфейс window.simpleConv. Откройте конвертер через приложение.");
      const initial = await api.getInitialState();
      state.settings = { ...defaults, ...initial.settings };
      for (const [key, labels] of Object.entries(videoSettingLabels)) {
        if (!Object.hasOwn(labels, state.settings[key])) state.settings[key] = "auto";
      }
      state.colors = [...new Set(initial.colors?.spaces || [])];
      state.defaultSpace = initial.colors?.defaultSpace || "ACES - ACES2065-1";
      state.ready = !!initial.runtime?.ready && state.colors.length > 0;
      state.initialized = true;
      if (state.settings.inputColorSpace && !state.colors.includes(state.settings.inputColorSpace)) state.settings.inputColorSpace = "";
      $("version").textContent = initial.version || "";
      $("config-label").textContent = initial.colors?.configLabel || "";
      $("config-label").title = initial.colors?.fingerprint || "";
      for (const space of state.colors) $("input-color").append(new Option(space, space));
      $("runtime-status").textContent = state.ready ? "Готов к работе" : "Backend недоступен";
      if (!state.ready) showMessage("startup-error", initial.runtime?.error || (state.colors.length ? "Backend не готов." : "Конфигурация OCIO не содержит цветовых пространств."));
      reflectSettings();
      const progressUnsubscribe = api.onProgress(onProgress);
      if (typeof progressUnsubscribe === "function") state.unsubscribers.push(progressUnsubscribe);
      const updateUnsubscribe = api.onUpdateProgress((progress) => {
        if (!progress) return;
        $("update-progress").hidden = false;
        if (Number.isFinite(Number(progress.percent))) $("update-progress").value = Math.max(0, Math.min(100, Number(progress.percent)));
        showMessage("update-status", progressText(progress, "Обновление…"));
        if (["done", "complete", "completed", "ready", "installed", "error", "failed", "cancelled", "canceled"].includes(progress.phase)) {
          state.installing = false;
          if (["done", "complete", "completed", "ready", "installed"].includes(progress.phase) && state.update) state.update.available = false;
          updateControls();
        }
      });
      if (typeof updateUnsubscribe === "function") state.unsubscribers.push(updateUnsubscribe);
      checkUpdate(true);
    } catch (error) {
      state.ready = false;
      $("runtime-status").textContent = "Ошибка запуска";
      showMessage("startup-error", messageOf(error));
      updateControls();
    }
  }

  window.addEventListener("beforeunload", () => {
    clearTimeout(state.previewTimer);
    clearTimeout(state.saveTimer);
    flushSave();
    for (const unsubscribe of state.unsubscribers) unsubscribe();
  });
  initialize();
})();
