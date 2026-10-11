"use strict";
const path = require("node:path").win32;

function installationPlan(executable, localAppData, hasUninstaller) {
  const directory = hasUninstaller ? path.dirname(executable) : path.join(localAppData, "Programs", "GFX Ai Conv Simple Preview");
  return { directory, executable: path.join(directory, "GFX Ai Conv Simple Preview.exe"), portable: !hasUninstaller };
}

function installationScript({ pid, installer, previousExecutable, plan, statusFile, version }) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid updater process ID");
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  const args = `/S /currentuser --updated /D=${plan.directory}`;
  return `$ErrorActionPreference = 'Stop'
Wait-Process -Id ${pid} -ErrorAction SilentlyContinue
$status = ${quote(statusFile)}
$launch = ${quote(plan.executable)}
function Save-UpdateStatus($value) {
  try { $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $status -Encoding UTF8 } catch { }
}
try {
  $p = Start-Process -FilePath ${quote(installer)} -ArgumentList ${quote(args)} -WindowStyle Hidden -PassThru -Wait
  if ($p.ExitCode -ne 0) { throw ('Installer exit code: ' + $p.ExitCode) }
  if (-not (Test-Path -LiteralPath $launch -PathType Leaf)) { throw 'Installed executable is missing' }
  Save-UpdateStatus @{ok=$true; version=${quote(version)}; message='Обновление установлено.'}
  Start-Process -FilePath $launch -WindowStyle Hidden | Out-Null
} catch {
  $failure = $_.Exception.Message
  Save-UpdateStatus @{ok=$false; version=${quote(version)}; message=$failure}
  $launch = ${quote(previousExecutable)}
  if (Test-Path -LiteralPath $launch -PathType Leaf) {
    try { Start-Process -FilePath $launch -WindowStyle Hidden | Out-Null }
    catch { Save-UpdateStatus @{ok=$false; version=${quote(version)}; message=($failure + '; Restart: ' + $_.Exception.Message)} }
  }
}
`;
}

module.exports = { installationPlan, installationScript };
