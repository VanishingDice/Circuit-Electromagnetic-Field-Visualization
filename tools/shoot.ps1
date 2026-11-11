# 批量截图（用于文档 / 检查各种场模式）
# 用法: pwsh -File tools/shoot.ps1
# 需要先启动本地服务器（start.bat，端口 8765）
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ud = Join-Path $env:TEMP "chrome-emlab-shots"
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "docs"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$base = "http://127.0.0.1:8765/index.html"

$shots = @(
  @{ name = "preview";       q = "" },
  @{ name = "b-field";       q = "?field=B&mode=stream&editor=0" },
  @{ name = "e-field";       q = "?field=E&mode=arrows&editor=0" },
  @{ name = "e-stream";      q = "?field=E&mode=stream&editor=0" },
  @{ name = "potential";     q = "?field=phi&mode=slice&editor=0" },
  @{ name = "poynting";      q = "?field=S&mode=arrows&editor=0" },
  @{ name = "poynting-lines";q = "?field=S&mode=stream&editor=0" },
  @{ name = "analysis";      q = "?field=S&mode=arrows&editor=0&analysis=1&wire=8" },
  @{ name = "editor";        q = "?field=B&mode=stream" }
)

foreach ($s in $shots) {
  $png = Join-Path $outDir ($s.name + ".png")
  if (Test-Path $png) { Remove-Item $png -Force }
  & $chrome --headless=new --no-sandbox --disable-breakpad --disable-crash-reporter `
    --user-data-dir="$ud" --enable-unsafe-swiftshader --use-angle=swiftshader `
    --hide-scrollbars --window-size=1600,950 --virtual-time-budget=10000 `
    --screenshot="$png" ($base + $s.q) 2>$null | Out-Null
  if (Test-Path $png) { Write-Output ("  docs/{0,-16} {1,8:N0} bytes" -f ($s.name + ".png"), (Get-Item $png).Length) }
  else { Write-Output ("  {0,-16} FAILED" -f $s.name) }
}
