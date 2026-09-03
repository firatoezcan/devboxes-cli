param(
  [string]$Version,
  [string]$InstallDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repository = "firatoezcan/devboxes-cli"
if (-not $Version) {
  $release = Invoke-RestMethod `
    -Headers @{ "User-Agent" = "devboxes-installer" } `
    -Uri "https://api.github.com/repos/$repository/releases/latest"
  $Version = $release.tag_name -replace "^v", ""
}
if ($Version -notmatch "^\d+\.\d+\.\d+$") {
  throw "Devboxes version must be X.Y.Z (got '$Version')."
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Devboxes does not currently publish a Windows 32-bit binary."
}

if (-not $InstallDir) {
  $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
  $InstallDir = Join-Path $localAppData "Programs\Devboxes\bin"
}

$asset = "devboxes-$Version-windows-x64.exe"
$baseUrl = "https://github.com/$repository/releases/download/v$Version"
$destination = Join-Path $InstallDir "devboxes.exe"
$staged = Join-Path $InstallDir ".devboxes-$([guid]::NewGuid().ToString("N")).exe"
$checksums = Join-Path $InstallDir ".devboxes-checksums-$([guid]::NewGuid().ToString("N"))"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile $checksums
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $staged

  $escapedAsset = [Regex]::Escape($asset)
  $checksumLine = Get-Content $checksums | Where-Object { $_ -match "^[0-9a-f]{64}\s+$escapedAsset$" }
  if (@($checksumLine).Count -ne 1) {
    throw "SHA256SUMS does not contain exactly one valid checksum for $asset."
  }
  $expected = ($checksumLine -split "\s+")[0]
  $actual = (Get-FileHash -Algorithm SHA256 $staged).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "Checksum verification failed for $asset."
  }

  $installedVersion = (& $staged --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $installedVersion -ne $Version) {
    throw "Downloaded binary reports version '$installedVersion', expected '$Version'."
  }

  if (Test-Path $destination) {
    [IO.File]::Replace($staged, $destination, [NullString]::Value)
  } else {
    [IO.File]::Move($staged, $destination)
  }
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $staged, $checksums
}

Write-Host "Installed Devboxes $Version at $destination"
if (($env:PATH -split [IO.Path]::PathSeparator) -notcontains $InstallDir) {
  Write-Host "Add $InstallDir to PATH, then open a new terminal."
}
Write-Host "Next: devboxes login"
