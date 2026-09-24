# ============================================================================
#  ARGO 請購單自動傳簽（本機執行）
# ----------------------------------------------------------------------------
#  為什麼要這支：ARGO 的請購單開出來是 UNSIGNED，要人進 ARGO 桌面程式按「傳簽」
#  才會進入簽核流程。2026-09-24 向廠商確認過傳簽沒有 API（IFAF105 不能更新
#  HOLD_STATUS、沒有專門的傳簽介面、傳簽文號不能由 API 帶入），所以只能在本機
#  用 UI 自動化按。
#
#  ⚠ ARGO 閒置 15 分鐘會自動斷線，所以這支**每次執行都要自己完整登入**，
#  不能假設 ARGO 已經開著——排程在 17:40 跑的時候，它一定早就斷了。
#  流程：啟動器 → 選公司別 → 登入 → 我的最愛「原物料請購作業」→ 逐張傳簽 → 關閉。
#
#  設計原則只有一條：**每按一張就向 ARGO 驗證一張，錯了立刻停。**
#  桌面自動化的失敗幾乎都是靜默的——視窗沒開、欄位沒對焦、按鈕位置跑掉，
#  腳本照樣跑完回報成功。沒有驗證的自動化比沒有自動化更危險，因為你不會發現。
#
#  用法：
#    .\argo-sign.ps1                   正式執行
#    .\argo-sign.ps1 -DryRun           只列出要處理的單號，完全不碰 ARGO
#    .\argo-sign.ps1 -Date 2026-09-24  指定日期補跑
#    .\argo-sign.ps1 -KeepOpen         跑完不關 ARGO（校準時方便看畫面）
# ============================================================================

[CmdletBinding()]
param(
  [string]$BaseUrl   = $env:ARGO_SIGN_BASE_URL,   # 例：https://bardshop-eip.vercel.app
  [string]$Secret    = $env:ARGO_SIGN_SECRET,     # 與伺服器的 WEBHOOK_SECRET 相同
  [string]$ArgoPath  = $env:ARGO_SIGN_EXE,        # ARGO 啟動器的完整路徑
  [string]$Company   = 'BARDSHOP',                # 啟動器上的公司別按鈕
  [string]$ArgoUser  = $env:ARGO_SIGN_USER,       # 留空＝沿用 Remember me 記住的帳號
  [string]$ArgoPass  = $env:ARGO_SIGN_PASSWORD,   # 留空＝沿用 Remember me 記住的密碼
  [string]$Date      = '',
  [switch]$DryRun,
  [switch]$KeepOpen,
  [int]$StepDelayMs  = 700,
  [int]$QueryWaitMs  = 2500,           # F8 查詢後等多久才開始 Tab
  [string]$ActivateKey = ' ',        # 按下傳簽用的鍵（空白鍵；真的不行再試 '{ENTER}'）
  [int]$WindowTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$LogDir  = Join-Path $PSScriptRoot 'logs'
$LogFile = Join-Path $LogDir ("argo-sign-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  if ($Level -eq 'ERROR')     { Write-Host $line -ForegroundColor Red }
  elseif ($Level -eq 'WARN')  { Write-Host $line -ForegroundColor Yellow }
  else                        { Write-Host $line }
}

if (-not $BaseUrl -or -not $Secret) {
  Write-Log '缺少 BaseUrl 或 Secret。請設定 ARGO_SIGN_BASE_URL / ARGO_SIGN_SECRET。' 'ERROR'
  exit 2
}

# ── 與系統溝通 ────────────────────────────────────────────────────────────
function Invoke-Api {
  param([string]$Query, [string]$What = '查詢')
  # 這支 API 要逐張問 ARGO，正常就要幾秒到十幾秒。沒有任何輸出的話，
  # 使用者會以為腳本當掉而中途 Ctrl+C，所以一定要先講一聲再等。
  Write-Host ("  {0}中…（要向 ARGO 逐張查詢，請稍候）" -f $What) -ForegroundColor DarkGray
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri "$BaseUrl/api/argoerp/pending-sign$Query" `
      -Headers @{ Authorization = "Bearer $Secret" } -TimeoutSec 120
    Write-Host ("  完成，耗時 {0:N1} 秒" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
    return $r
  } catch {
    Write-Log ("呼叫 API 失敗（耗時 {0:N1} 秒）：{1}" -f $sw.Elapsed.TotalSeconds, $_.Exception.Message) 'ERROR'
    throw
  }
}
function Get-DocStatus { param([string]$DocNo) Invoke-Api "?verify=$DocNo" -What "驗證 $DocNo" }

# ── 視窗工具 ──────────────────────────────────────────────────────────────
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

# ⚠ 2026-09-24 實測確認的視窗結構——這段決定了所有「等畫面」的寫法：
#
#   啟動器      程序 ArgoERP   標題「ArgoERP」
#   登入後主視窗 程序 java      標題「啟盛國際股份有限公司(BARDSHOP):10149@BARDSHOP 2026/09/24 18:47 上線人數:5」
#
# 兩個關鍵限制：
#   ① 登入後的標題含「即時時間 + 上線人數」，每分鐘都在變，只能用萬用字元比對，
#      絕不能寫死整串。
#   ② ARGO 是 MDI：登入畫面、主選單、原物料請購作業全都是「同一個 java 頂層視窗」
#      裡面的子視窗。子視窗標題（APPF00061 v4.67、原物料請購作業–PJAF084 v4.23）
#      在 EnumWindows / MainWindowTitle 裡看不到。
#      => 靠頂層標題只能判斷「登入了沒」，判斷不出「現在停在哪一個作業畫面」。
#         要分辨子畫面得靠 Java Access Bridge（UiPath 的 Java 活動或 pywinauto+JAB）。
function Get-ArgoWindow {
  param([string]$TitlePattern, [string]$ProcessPattern = '.')
  Get-Process | Where-Object {
    $_.MainWindowTitle -and $_.MainWindowTitle -like $TitlePattern -and $_.ProcessName -match $ProcessPattern
  } | Select-Object -First 1
}

# 等某個視窗出現——所有等待一律用「等條件成立」而不是固定 sleep。
# ARGO 慢的時候固定等待一定會踩空，而且踩空的症狀是靜默的。
function Wait-Window {
  param([string]$TitlePattern, [int]$TimeoutSec = $WindowTimeoutSec, [string]$What = '視窗', [string]$ProcessPattern = '.')
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $p = Get-ArgoWindow $TitlePattern $ProcessPattern
    if ($p) { return $p }
    Start-Sleep -Milliseconds 400
  }
  throw "等不到${What}（標題符合 $TitlePattern），已等 $TimeoutSec 秒"
}

function Focus-Window {
  param($Proc)
  if ([Win]::IsIconic($Proc.MainWindowHandle)) { [Win]::ShowWindow($Proc.MainWindowHandle, 9) | Out-Null }
  [Win]::SetForegroundWindow($Proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds $StepDelayMs
}

function Send-Keys {
  param([string]$Keys, [int]$DelayMs = $StepDelayMs)
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $DelayMs
}

# ── 登入：每次執行都要做，因為 ARGO 閒置 15 分鐘就斷線 ────────────────────
function Start-Argo {
  # 已經開著就直接用（手動測試時常見），否則啟動
  # 已經登入就沿用（登入後的主視窗屬於 java 程序，標題帶公司別與上線人數）
  $logged = Get-ArgoWindow '*BARDSHOP*' 'java'
  if ($logged) { Write-Log ('ARGO 已登入：' + $logged.MainWindowTitle); Focus-Window $logged; return $logged }

  if (-not $ArgoPath) { throw '未設定 ARGO_SIGN_EXE（ARGO 啟動器路徑），無法自動登入' }
  if (-not (Test-Path $ArgoPath)) { throw "ARGO 啟動器不存在：$ArgoPath" }

  Write-Log "啟動 ARGO：$ArgoPath"
  Start-Process -FilePath $ArgoPath | Out-Null

  # ① 啟動器視窗 → 選公司別
  $launcher = Wait-Window 'ArgoERP' -What '啟動器' -ProcessPattern 'ArgoERP'
  Focus-Window $launcher
  # ▼ 待校準 A：選公司別。啟動器上是 BARDSHOP / TEST 兩顆按鈕。
  #   若可用鍵盤（Tab 移動 + Enter）就用鍵盤；不行的話這裡要改成依座標或 UI 元素點擊。
  Send-Keys '{ENTER}'   # ← 預設按鈕通常就是第一顆（BARDSHOP），校準後視情況調整

  # ② 登入視窗 → 送出
  # 登入畫面是 java 頂層視窗裡的 MDI 子視窗，頂層標題此時還是「Argo」
  $login = Wait-Window '*Argo*' -What '登入視窗' -ProcessPattern 'java|Argo'
  Focus-Window $login
  # 帳密留空＝沿用 ARGO 的 Remember me（建議做法：密碼不要進腳本、不要進環境變數）
  if ($ArgoUser) {
    # ▼ 待校準 B：把焦點移到「使用者」欄再輸入（用 Remember me 就不會走到這）
    Send-Keys $ArgoUser
    if ($ArgoPass) { Send-Keys '{TAB}'; Send-Keys $ArgoPass }
  }
  Send-Keys '{ENTER}'   # ← 待校準 C：送出登入（Enter 或點 Login）

  # ③ 主選單 → 我的最愛「原物料請購作業」
  # 登入成功的判斷：頂層標題換成「…(BARDSHOP):帳號@BARDSHOP 日期 時間 上線人數:N」
  $menu = Wait-Window '*BARDSHOP*' -What '主選單（登入完成）' -ProcessPattern 'java'
  Focus-Window $menu
  # ▼ 待校準 D：開啟「原物料請購作業」。它在右側「我的最愛」第一項。
  #   Oracle Forms 的選單通常可用鍵盤巡覽；若不行，這裡改用 UI Automation 依文字點擊
  #   （需先啟用 Java Access Bridge：jabswitch -enable 後重開機）。
  Send-Keys '{TAB}{ENTER}'   # ← 佔位，務必校準

  # ④ 等表單真的開起來
  # ⚠ 注意：這裡沒辦法用標題確認「原物料請購作業」真的開了——它是 MDI 子視窗，
  # 頂層標題不會變。目前只能確認「已登入」，子畫面是否正確要靠後續的逐張驗證兜底。
  $form = Wait-Window '*BARDSHOP*' -What '主視窗' -ProcessPattern 'java'
  Focus-Window $form
  Write-Log '已登入（無法由標題確認子畫面，改由每張單的傳簽結果驗證）'
  return $form
}

function Stop-Argo {
  if ($KeepOpen) { Write-Log 'KeepOpen：保留 ARGO 視窗'; return }
  Get-Process | Where-Object {
    $_.ProcessName -match '^(ArgoERP|java|javaw)$'
  } | ForEach-Object {
    try { $_.CloseMainWindow() | Out-Null } catch { }
  }
  Write-Log '已關閉 ARGO'
}

# ── 單張傳簽 ──────────────────────────────────────────────────────────────
function Sign-OneDoc {
  param([string]$DocNo)
  $form = Wait-Window '*BARDSHOP*' -TimeoutSec 15 -What 'ARGO 主視窗' -ProcessPattern 'java'
  Focus-Window $form

  # ── 實測校準（2026-09-24 由現場操作人員提供）────────────────────────
  #   F7 進入查詢模式（焦點直接落在「請購單號」欄，不需再 Tab）
  #   貼上單號
  #   F8 執行查詢
  #   Tab × 15 移到「傳簽」按鈕
  #   空白鍵按下去
  #
  # 為什麼用空白鍵而不是 Enter：Java 介面裡空白鍵只會觸發「目前有焦點的」按鈕，
  # Enter 則可能觸發畫面的預設按鈕——萬一 Tab 數錯，Enter 會去按到別的東西
  # （這個畫面上就有「作廢」），空白鍵頂多沒反應。失敗要往安全的方向倒。
  Send-Keys '{F7}'
  Send-Keys $DocNo
  Send-Keys '{F8}'

  # 查詢要跑一下才會把資料帶出來；這裡多等一點，
  # 沒查到資料就 Tab 過去按傳簽 = 對著空白單按，會出事
  Start-Sleep -Milliseconds $QueryWaitMs

  Send-Keys '{TAB 15}'
  Send-Keys $ActivateKey

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
if ($DryRun)              { Write-Log 'DryRun：只列清單，不碰 ARGO。'; exit 0 }

$ok = 0; $failed = @()
try {
  Start-Argo | Out-Null
} catch {
  Write-Log "登入 ARGO 失敗：$($_.Exception.Message)" 'ERROR'
  exit 4
}

foreach ($doc in $pending) {
  Write-Log "處理 $doc …"
  try {
    Sign-OneDoc -DocNo $doc
  } catch {
    Write-Log "  操作 ARGO 失敗：$($_.Exception.Message)" 'ERROR'
    $failed += $doc
    break   # 視窗層級的問題，後面的單也不會成功
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

Stop-Argo
Write-Log ("===== 結束：成功 {0} 張，失敗 {1} 張 =====" -f $ok, $failed.Count)
if ($failed.Count -gt 0) {
  Write-Log ("未完成：{0}（請手動進 ARGO 處理）" -f ($failed -join ', ')) 'WARN'
  exit 1
}
exit 0
