"use strict";

const path = require("path");
const semver = require("semver");

const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

function normalizeVersion(value) {
  return semver.clean(String(value || "").trim()) || "";
}

function isNewerVersion(latest, current) {
  const normalizedLatest = normalizeVersion(latest);
  const normalizedCurrent = normalizeVersion(current);
  return Boolean(
    normalizedLatest
    && normalizedCurrent
    && semver.gt(normalizedLatest, normalizedCurrent)
  );
}

function normalizeSha256Digest(value) {
  const match = String(value || "").trim().match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : "";
}

function validateInstallerAsset(asset, repository, expectedVersion = "", product = "GFX Ai Conv") {
  if (!asset || typeof asset !== "object") {
    throw new Error("В релизе отсутствует установщик обновления.");
  }

  const name = String(asset.name || "").trim();
  const productPattern = product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[. ]");
  const nameMatch = name.match(new RegExp(`^${productPattern}-([0-9A-Za-z.+-]+)-installer-x64\\.exe$`, "i"));
  if (
    !name
    || name !== path.basename(name)
    || !nameMatch
  ) {
    throw new Error("Имя установщика в релизе не прошло проверку.");
  }

  const installerVersion = normalizeVersion(nameMatch[1]);
  const normalizedExpectedVersion = normalizeVersion(expectedVersion);
  if (
    !installerVersion
    || (normalizedExpectedVersion && installerVersion !== normalizedExpectedVersion)
  ) {
    throw new Error("Версия установщика не совпадает с версией GitHub Release.");
  }

  const downloadUrl = String(asset.browser_download_url || asset.downloadUrl || "").trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(downloadUrl);
  } catch (_error) {
    throw new Error("GitHub вернул некорректный адрес установщика.");
  }

  const expectedPrefix = `/${repository.owner}/${repository.name}/releases/download/`.toLowerCase();
  if (
    parsedUrl.protocol !== "https:"
    || parsedUrl.hostname.toLowerCase() !== "github.com"
    || !parsedUrl.pathname.toLowerCase().startsWith(expectedPrefix)
  ) {
    throw new Error("Адрес установщика не относится к официальному GitHub-репозиторию.");
  }

  const size = Number(asset.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) {
    throw new Error("Размер установщика в релизе некорректен.");
  }

  const sha256 = normalizeSha256Digest(asset.digest || asset.sha256);
  if (!sha256) {
    throw new Error("GitHub Release не содержит SHA-256 установщика.");
  }

  return {
    name,
    version: installerVersion,
    size,
    downloadUrl: parsedUrl.href,
    sha256
  };
}

function verifyInstallerDownload(asset, downloadedBytes, actualSha256) {
  if (downloadedBytes !== asset.size) {
    throw new Error(
      `Установщик скачан не полностью: ${downloadedBytes} из ${asset.size} байт.`
    );
  }

  if (String(actualSha256 || "").toLowerCase() !== asset.sha256) {
    throw new Error("SHA-256 скачанного установщика не совпадает с GitHub Release.");
  }
}

module.exports = {
  isNewerVersion,
  normalizeSha256Digest,
  normalizeVersion,
  validateInstallerAsset,
  verifyInstallerDownload
};
