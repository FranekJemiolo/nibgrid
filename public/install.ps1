$ErrorActionPreference = "Stop"
$Repo = "FranekJemiolo/nibgrid"
$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Tag = $Release.tag_name
if ([string]::IsNullOrWhiteSpace($Tag)) {
  throw "Failed to resolve latest release tag for $Repo."
}

$Version = $Tag.TrimStart("v")
$Asset = "Nibgrid-Studio-$Version-win-x64-setup.exe"
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"

$Tmp = Join-Path $env:TEMP "nibgrid-install"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Installer = Join-Path $Tmp $Asset
$SumsFile = Join-Path $Tmp "SHA256SUMS.txt"

try {
  Write-Host "Downloading $Asset ($Tag)..."
  Invoke-WebRequest "$BaseUrl/$Asset" -OutFile $Installer
  Invoke-WebRequest "$BaseUrl/SHA256SUMS.txt" -OutFile $SumsFile

  $Match = Select-String -Path $SumsFile -Pattern "  $([regex]::Escape($Asset))$" | Select-Object -First 1
  if (-not $Match) {
    throw "Missing checksum entry for $Asset in SHA256SUMS.txt!"
  }
  $Expected = $Match.Line.Split(" ")[0].ToLower()
  $Actual = (Get-FileHash -Path $Installer -Algorithm SHA256).Hash.ToLower()
  if ([string]::IsNullOrWhiteSpace($Expected) -or ($Expected -ne $Actual)) {
    throw "SHA-256 checksum mismatch! Expected $Expected, got $Actual"
  }

  Write-Host "Launching Nibgrid Studio installer..."
  Start-Process -FilePath $Installer -ArgumentList "/SILENT" -Wait
  Write-Host "Nibgrid Studio installed."
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
}
