# ============================================================================
#  ARGO 視窗／UI 偵測工具（校準用，完全唯讀，不會點任何東西）
# ----------------------------------------------------------------------------
#  用途：自動化腳本要靠「視窗標題」找到 ARGO 的各個畫面，但 ArgoERP.exe 本身
#  沒有視窗——它只是啟動器，真正的畫面是它叫起來的 Java（Oracle Forms）程序。
#  這支就是用來把「現在畫面上這個視窗，到底屬於哪個程序、標題是什麼」抓出來，
#  抓到的字串直接填進 argo-sign.ps1 的視窗比對條件。
#
#  用法：
#    1. 手動把 ARGO 開到你要校準的那一步（啟動器／登入畫面／主選單／請購作業）
#    2. 執行這支：.\capture-argo-ui.ps1
#    3. 把輸出的視窗標題記下來
#
#  也可以持續監看，一邊操作 ARGO 一邊看標題怎麼變：
#    .\capture-argo-ui.ps1 -Watch
# ============================================================================

[CmdletBinding()]
param([switch]$Watch, [int]$IntervalSec = 2)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public static List<string> All() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (t.Length > 0) { uint pid; GetWindowThreadProcessId(h, out pid); list.Add(pid + "\t" + c + "\t" + t); }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

function Show-Snapshot {
  Write-Host ("=" * 78)
  Write-Host ("掃描時間：{0}" -f (Get-Date -Format 'HH:mm:ss')) -ForegroundColor Cyan

  # ① ARGO 與 Java 程序（含 32/64 位元——影響要用哪個 Access Bridge）
  Write-Host "`n[程序]" -ForegroundColor Yellow
  $procs = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match '^(ArgoERP|java|javaw)$' }
  if (-not $procs) { Write-Host "  找不到 ArgoERP / java 程序——ARGO 沒開？" -ForegroundColor DarkGray }
  foreach ($p in $procs) {
    $path = try { $p.Path } catch { '(無權讀取)' }
    $bits = try { if ([System.Reflection.AssemblyName]::GetAssemblyName($p.Path)) { '' } } catch { '' }
    $hasWin = if ($p.MainWindowHandle -ne 0) { "有視窗：$($p.MainWindowTitle)" } else { '無視窗' }
    Write-Host ("  PID {0,-6} {1,-10} {2}" -f $p.Id, $p.ProcessName, $hasWin)
    Write-Host ("         路徑：{0}" -f $path) -ForegroundColor DarkGray
  }

  # ② 所有看得見的視窗，標出屬於 ARGO/Java 的
  Write-Host "`n[可見視窗]（★ = 屬於 ARGO 或 Java）" -ForegroundColor Yellow
  $argoPids = @($procs | ForEach-Object { $_.Id })
  foreach ($line in [WinEnum]::All()) {
    $f = $line -split "`t", 3
    $wpid = [int]$f[0]
    $pname = try { (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { '?' }
    $isArgo = ($argoPids -contains $wpid) -or ($pname -match 'argo|java')
    if ($isArgo) {
      Write-Host ("  ★ PID {0,-6} {1,-10} class={2,-22} 標題：{3}" -f $wpid, $pname, $f[1], $f[2]) -ForegroundColor Green
    }
  }
  Write-Host "`n把上面 ★ 那幾行的「標題」記下來，填進 argo-sign.ps1 的 Wait-Window 比對條件。" -ForegroundColor Cyan
}

if ($Watch) {
  Write-Host "持續監看中（Ctrl+C 結束）。請一邊操作 ARGO，一邊看標題怎麼變。" -ForegroundColor Cyan
  while ($true) { Show-Snapshot; Start-Sleep -Seconds $IntervalSec }
} else {
  Show-Snapshot
}
