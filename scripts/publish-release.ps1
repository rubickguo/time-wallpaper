param(
  [string]$Version = "",
  [string]$Repo = "rubickguo/time-wallpaper",
  [string]$Message = "Release"
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
  $package = Get-Content -Path "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  $Version = [string]$package.version
}

$tag = "v$Version"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

Write-Host "Building Windows release for $tag..."
npm run dist

Write-Host "Checking repository state..."
$status = git status --porcelain
if ($status) {
  git add .github .gitignore README.md README.en.md index.html package-lock.json package.json scripts src
  git commit -m "$Message $tag"
}

$existingTag = git tag --list $tag
if (-not $existingTag) {
  git tag $tag
}

Write-Host "Pushing main and $tag..."
git push origin main
git push origin $tag

$assets = @(
  "release/时间壁纸 Setup $Version.exe",
  "release/时间壁纸 $Version.exe",
  "release/时间壁纸-$Version-win.zip"
) | Where-Object { Test-Path $_ }

if ($assets.Count -eq 0) {
  throw "No release assets found for version $Version."
}

$notes = @"
Windows release $tag.

Downloads:
- Setup installer
- Portable app
- Zip package
"@

$releaseExists = $false
try {
  gh release view $tag --repo $Repo | Out-Null
  $releaseExists = $true
} catch {
  $releaseExists = $false
}

if ($releaseExists) {
  Write-Host "Uploading assets to existing GitHub Release $tag..."
  gh release upload $tag @assets --repo $Repo --clobber
} else {
  Write-Host "Creating GitHub Release $tag..."
  gh release create $tag @assets --repo $Repo --title "Time Wallpaper $tag" --notes $notes
}

Write-Host "Published: https://github.com/$Repo/releases/tag/$tag"

