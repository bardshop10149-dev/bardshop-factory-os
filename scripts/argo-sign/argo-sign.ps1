# ============================================================================
#  ARGO 請購單自動傳簽（本機執行）
# ----------------------------------------------------------------------------
#  為什麼要這支：ARGO 的請購單開出來是 UNSIGNED，要人進 ARGO 桌面程式按「傳簽」
#  才會進入簽核流程。2026-09-24 向廠商確認過傳簽沒有 API（IFAF105 不能更新
#  HOLD_STATUS、沒有專門的傳簽介面、傳簽文號不能由 API 帶入），所以只能在本機
#  用 UI 自動化按。
#
#  這支腳本的設計原則只有一條：**每按一張就向 ARGO 驗證一張，錯了立刻停。**
#  桌面自動化的失敗幾乎都是靜默的——視窗沒開、欄位沒對焦、按鈕位置跑掉，
#  腳本照樣跑完回報成功。沒有驗證的自動化比沒有自動化更危險，因為你不會發現。
#
#  執行流程：
#    1. 向系統要今天「還沒傳簽」的單號（不在 ARGO 裡用日期搜尋，直接拿單號）
#    2. 逐張：在 ARGO 查詢該單號 → 按傳簽
#    3. 每張按完立刻打 API 回查 HOLD_STATUS 是否已離開 UNSIGNED
#    4. 沒變成功就停下來，寫 log 並回傳非 0 離開碼（工作排程器會記錄失敗）
#
#  用法：
#    .\argo-sign.ps1                 正式執行
#    .\argo-sign.ps1 -DryRun         只列出要處理的單號，不碰 ARGO
#    .\argo-sign.ps1 -Date 2026-09-24  指定日期補跑
# ============================================================================

[CmdletBinding()]
param(
  [string]$BaseUrl = $env:ARGO_SIGN_BASE_URL,      # 例：https://bardshop-eip.vercel.app
  [string]$Secret  = $env:ARGO_SIGN_SECRET,        # 與伺服器的 WEBHOOK_SECRET 相同
  [string]$Date    = '',
  [switch]$DryRun,
  [int]$StepDelayMs = 700                          # 每個 UI 動作之間的間隔
)

$ErrorActionPreference = 'Stop'
$LogDir  = Join-Path $PSScriptRoot 'logs'
$LogFile = Join-Path $LogDir ("argo-sign-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
  elseif ($Level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
  else { Write-Host $line }
}

if (-not $BaseUrl -or -not $Secret) {
  Write-Log '缺少 BaseUrl 或 Secret。請設定環境變數 ARGO_SIGN_BASE_URL / ARGO_SIGN_SECRET，或用參數傳入。' 'ERROR'
  exit 2
}

# ── 與系統溝通 ────────────────────────────────────────────────────────────
function Invoke-Api {
  param([string]$Query)
  $uri = "$BaseUrl/api/argoerp/pending-sign$Query"
  return Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $Secret" } -TimeoutSec 60
}

function Get-DocStatus {
  param([string]$DocNo)
  $r = Invoke-Api "?verify=$DocNo"
  return $r
}

# ── ARGO 視窗操作 ─────────────────────────────────────────────────────────
#  這一段是唯一與 ARGO 畫面綁定的部分，換版或改版面要調的就是這裡。
#  刻意不寫死螢幕座標——座標會因為視窗位置、解析度、縮放比例而跑掉。
#  改用「聚焦視窗 → 鍵盤操作」：鍵盤序列跟著焦點走，視窗在哪裡都一樣。
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

function Focus-Argo {
  # ARGO 主視窗標題含「原物料請購作業」；找不到就找 ArgoERP 主視窗
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*請購*' -or $_.MainWindowTitle -like '*ArgoERP*' } | Select-Object -First 1
  if (-not $p) { throw 'ARGO 視窗找不到——請先手動開啟 ARGO 並切到「原物料請購作業」，本腳本不負責登入。' }
  if ([Win]::IsIconic($p.MainWindowHandle)) { [Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null }
  [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds $StepDelayMs
  return $p
}

function Send-Keys {
  param([string]$Keys)
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $StepDelayMs
}

function Sign-OneDoc {
  param([string]$DocNo)
  Add-Type -AssemblyName System.Windows.Forms

  Focus-Argo | Out-Null

  # ▼▼▼ 以下四步需要在你的機器上實際校準一次 ▼▼▼
  #  校準方式：手動做一次完整流程，把每一步用到的按鍵記下來替換進去。
  #  （ARGO 是 Oracle Forms，大多數操作都有鍵盤對應，優先用快捷鍵而不是滑鼠點擊）
  #
  #  1) 進入查詢模式：ARGO 工具列的「查詢」通常是 F7
  Send-Keys '{F7}'
  #  2) 游標移到「請購單號」欄位並輸入單號
  #     若 F7 後焦點不在單號欄，這裡要補 {TAB} 或 +{TAB} 調整
  Send-Keys $DocNo
  #  3) 執行查詢：通常是 F8
  Send-Keys '{F8}'
  #  4) 按「傳簽」按鈕——若有快捷鍵就用快捷鍵；沒有的話這一行要改成
  #     以 UI Automation 依按鈕名稱點擊（見 docs 的說明）
  Send-Keys '%{F12}'   # ← 佔位：實際快捷鍵請校準後替換
  # ▲▲▲ 校準區結束 ▲▲▲

  Start-Sleep -Seconds 2   # 等 ARGO 送出並回寫
}

# ── 主流程 ────────────────────────────────────────────────────────────────
Write-Log '===== 開始 ====='
$query = if ($Date) { "?date=$Date" } else { '' }
$list = Invoke-Api $query

if (-not $list.success) { Write-Log "取得待傳簽清單失敗：$($list.error)" 'ERROR'; exit 3 }

$pending = @($list.pending)
Write-Log ("日期 {0}：今天開出 {1} 張，其中待傳簽 {2} 張" -f $list.date, @($list.all).Count, $pending.Count)
foreach ($d in $list.all) { Write-Log ("  {0}  {1}  {2}" -f $d.doc_no, $d.run_type, $d.status) }

if ($pending.Count -eq 0) { Write-Log '沒有待傳簽的單，結束。'; exit 0 }
if ($DryRun) { Write-Log 'DryRun：只列清單，不碰 ARGO。'; exit 0 }

$ok = 0; $failed = @()
foreach ($doc in $pending) {
  Write-Log "處理 $doc …"
  try {
    Sign-OneDoc -DocNo $doc
  } catch {
    Write-Log "  操作 ARGO 失敗：$($_.Exception.Message)" 'ERROR'
    $failed += $doc
    break   # 視窗層級的問題，後面的單也不會成功，直接停
  }

  # 關鍵：向 ARGO 求證，不相信「腳本跑完了」這件事
  $st = Get-DocStatus -DocNo $doc
  if ($st.signed) {
    Write-Log ("  ✅ 已傳簽（狀態 {0}，簽核文件 {1}）" -f $st.status, $st.flowDoc)
    $ok++
  } else {
    Write-Log ("  ❌ 按完之後狀態仍是 {0}——傳簽沒有生效，停止後續處理" -f $st.status) 'ERROR'
    $failed += $doc
    break
  }
}

Write-Log ("===== 結束：成功 {0} 張，失敗 {1} 張 =====" -f $ok, $failed.Count)
if ($failed.Count -gt 0) {
  Write-Log ("未完成：{0}（請手動進 ARGO 處理）" -f ($failed -join ', ')) 'WARN'
  exit 1
}
exit 0
