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
#  流程：啟動器 → 點公司別 → 登入 → 打程式代號進原物料請購作業 → 逐張傳簽 → 關閉。
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
#    .\argo-sign.ps1 -LoginOnly -KeepOpen
#        只跑「登入 + 開啟原物料請購作業」就停，完全不按傳簽。
#        用來在有人看著畫面的時候驗證登入流程，不必等到真的有單要簽。
# ============================================================================

[CmdletBinding()]
param(
  [string]$BaseUrl   = $env:ARGO_SIGN_BASE_URL,   # 例：https://bardshop-eip.vercel.app
  [string]$Secret    = $env:ARGO_SIGN_SECRET,     # 這支腳本專屬的鑰匙
  [string]$ArgoPath  = $env:ARGO_SIGN_EXE,        # ARGO 啟動器的完整路徑
  [string]$Company   = 'BARDSHOP',                # 啟動器上的公司別按鈕文字
  [string]$Date      = '',
  [switch]$DryRun,
  [switch]$LoginOnly,
  [switch]$KeepOpen,
  [int]$StepDelayMs  = 700,
  [int]$QueryWaitMs  = 2500,            # F8 查詢後等多久才開始 Tab
  [int]$LoginWaitMs  = 4000,            # 登入畫面讀完資料才吃得到按鍵，要先等
  [int]$FormWaitMs   = 4000,            # 送出程式代號後等作業畫面開起來
  [string]$ProgramCode = 'PJAF084',     # 原物料請購作業的程式代號
  [string]$ActivateKey = '{ENTER}',     # 按下傳簽用的鍵（現場實際用 Enter；備案是空白鍵 ' '）
  [int]$WindowTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int extra);
  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(LEFTDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(60);
    mouse_event(LEFTUP, 0, 0, 0, 0);
  }
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

# 啟動器上的公司別按鈕只能用滑鼠點。2026-09-24 實測：它是 WinForms 按鈕
# （class WindowsForms10.BUTTON…），但 UI Automation 把它歸類成 Pane，
# 而且不支援任何 pattern——沒有 InvokePattern 可以「直接觸發」，鍵盤也走不到。
#
# 不過這裡刻意不寫死座標：中心點是執行當下用 UI Automation 查出來的，
# 所以視窗被移動、解析度改變、按鈕排列調整都還是點得到。
# 寫死座標的版本明天換個螢幕就會靜默點空，那正是這支腳本最要避免的失敗模式。
function Invoke-ElementClick {
  param($Proc, [string]$Name, [int]$TimeoutSec = 20)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($Proc.MainWindowHandle)
      if ($root) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($el -and $el.Current.IsEnabled) {
          $r = $el.Current.BoundingRectangle
          if ($r.Width -gt 0 -and $r.Height -gt 0) {
            $x = [int]($r.X + $r.Width / 2)
            $y = [int]($r.Y + $r.Height / 2)
            Write-Log ("  點擊「{0}」於 ({1},{2})" -f $Name, $x, $y)
            [Win]::ClickAt($x, $y)
            return
          }
        }
      }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  throw "找不到可點擊的元件「$Name」（已等 $TimeoutSec 秒）"
}

# ── 登入：每次執行都要做，因為 ARGO 閒置 15 分鐘就斷線 ────────────────────
# 各步驟的按鍵序列都是 2026-09-24 由現場操作人員實測提供，不是猜的。
function Connect-Argo {
  # 手動測試時 ARGO 常常已經開著並登入好了，這種情況直接沿用，不要重開一份
  $logged = Get-ArgoWindow '*BARDSHOP*' 'java'
  if ($logged) {
    Write-Log ('ARGO 已登入，沿用現有視窗：' + $logged.MainWindowTitle)
    Focus-Window $logged
    return $logged
  }

  if (-not $ArgoPath) { throw '未設定 ARGO_SIGN_EXE（ARGO 啟動器路徑），無法自動登入' }
  if (-not (Test-Path $ArgoPath)) { throw "ARGO 啟動器不存在：$ArgoPath" }

  # 斷線後 ArgoERP.exe 不一定會自己結束，可能留下沒有視窗的殘留程序。
  # 不清掉的話下面找「啟動器視窗」會抓到殘留的那個，然後一直等不到按鈕。
  $stale = @(Get-Process ArgoERP -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 })
  if ($stale.Count -gt 0) {
    Write-Log ("清掉 {0} 個沒有視窗的殘留 ArgoERP 程序" -f $stale.Count)
    foreach ($z in $stale) { try { $z.Kill() } catch { } }
    Start-Sleep -Milliseconds 800
  }

  Write-Log "啟動 ARGO：$ArgoPath"
  Start-Process -FilePath $ArgoPath | Out-Null

  # ① 啟動器 → 點公司別（只能用滑鼠，見 Invoke-ElementClick 的說明）
  $launcher = Wait-Window 'ArgoERP' -What '啟動器' -ProcessPattern 'ArgoERP'
  Focus-Window $launcher
  Invoke-ElementClick -Proc $launcher -Name $Company

  # ② 登入畫面 → Tab×3 + Enter
  #    帳密不必輸入：ARGO 的 Remember me 會把上次的帳號密碼帶好（也因此密碼
  #    不用進腳本、不用進環境變數）。但畫面要先把資料讀出來才吃得到按鍵，
  #    太早送 Tab 會全部掉進虛空，所以固定等 $LoginWaitMs。
  #
  #    這裡用「有標題的 java 視窗」而不是比對標題文字：登入前的頂層標題
  #    含「Argo」，但啟動器自己也叫 ArgoERP，用 '*Argo*' 比對會抓到啟動器。
  #    這台機器上 java 只有 ARGO 在用，所以「任何 java 視窗」就是準確的條件。
  $login = Wait-Window '*' -What '登入畫面' -ProcessPattern 'java'
  Focus-Window $login
  Write-Log ("  等登入畫面載入（{0:N1} 秒）…" -f ($LoginWaitMs / 1000))
  Start-Sleep -Milliseconds $LoginWaitMs
  Focus-Window $login
  Send-Keys '{TAB 3}'
  Send-Keys '{ENTER}'

  # ③ 等登入完成——依據是頂層標題換成「…(BARDSHOP):帳號@BARDSHOP … 上線人數:N」
  $menu = Wait-Window '*BARDSHOP*' -What '主選單（登入完成）' -ProcessPattern 'java' -TimeoutSec 90
  Focus-Window $menu
  Write-Log ('  已登入：' + $menu.MainWindowTitle)
  return $menu
}

# 從主選單進「原物料請購作業」。
# 直接打程式代號，而不是點右側「我的最愛」：不受清單順序與捲動位置影響，
# 也不需要滑鼠，是這套流程裡最不容易壞的一步。
function Open-Program {
  param($Proc)
  Focus-Window $Proc
  Send-Keys $ProgramCode
  Send-Keys '{ENTER}'
  Start-Sleep -Milliseconds $FormWaitMs
  # ⚠ 沒辦法用標題確認作業畫面真的開了——它是 MDI 子視窗，頂層標題不會變。
  # 由每張單按完的驗證兜底：沒開成功，第一張就會驗不過而停下。
  Write-Log ("已送出程式代號 {0}（子畫面無法由標題確認，改由逐張驗證兜底）" -f $ProgramCode)
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
  #   Enter 按下去
  #
  # 按下傳簽用 Enter——這是現場實際的操作方式（2026-09-24 操作人員確認）。
  #
  # 我原本想用空白鍵：Java 介面裡空白鍵只觸發「目前有焦點的」按鈕，Enter 則可能
  # 觸發畫面的預設按鈕，萬一 Tab 數錯就會按到別的東西（這畫面上就有「作廢」）。
  # 但現場用 Enter 是行得通的事實，猜測讓位給實測。
  #
  # 代價要記著：這條路對「Tab 次數」的正確性比較敏感。如果 ARGO 改版讓欄位增減、
  # Tab 15 下落在別的按鈕上，Enter 會直接按下去。所以每張單按完一定要驗證
  # （下面的 Get-DocStatus），而且驗證失敗就立刻停、不要繼續按下一張。
  # 真要保守可用 -ActivateKey ' ' 改回空白鍵。
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

# LoginOnly：只驗證「登入 + 開作業畫面」這段，不查清單也不按任何鍵。
# 刻意排在查清單之前——登入流程跟今天有沒有單要簽無關，不該為了測登入
# 先等 30 秒去問 ARGO。今天的單已經人工簽完的日子也照樣測得起來。
if ($LoginOnly) {
  try {
    $main = Connect-Argo
    Open-Program -Proc $main
  } catch {
    Write-Log "LoginOnly 失敗：$($_.Exception.Message)" 'ERROR'
    exit 4
  }
  Write-Log 'LoginOnly：已停在原物料請購作業，未按任何傳簽。請看畫面確認停在正確的作業上。'
  Stop-Argo
  exit 0
}

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
  $main = Connect-Argo
  Open-Program -Proc $main
} catch {
  Write-Log "登入 ARGO 或開啟請購作業失敗：$($_.Exception.Message)" 'ERROR'
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
