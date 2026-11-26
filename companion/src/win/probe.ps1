# Kaashify Windows probe: one long-lived PowerShell sidecar that tells the
# overlay what is on screen without screenshots, native modules, or global
# hooks. JSON lines in on stdin, JSON lines out on stdout.
#
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"fg"}                                  foreground window
#   {"op":"win.list","ignorePid":123}                   open top-level windows: title, process, rect
#   {"id":3,"op":"uia.list","hwnd":123,"max":150}       interactive controls
#   {"id":4,"op":"uia.frompoint","x":100,"y":200}       control under a point
#   {"id":5,"op":"uia.find","hwnd":123,"name":"Add a Game","type":"Button"}
#   {"id":9,"op":"uia.selection","ignorePid":42,"max":20000}  selected text
#   {"id":10,"op":"uia.text","hwnd":123,"max":200000}      the window's words
#   {"id":6,"op":"watch.start","keys":[27],"click":true,"fg":true}
#   {"id":7,"op":"watch.stop"}
#
# Unsolicited events while watching:
#   {"ev":"click","x":..,"y":..}     left button released (physical px)
#   {"ev":"key","vk":27,"down":true}  a watched key changed
#   {"ev":"fg",...}                    the foreground window changed
#
# All coordinates are physical screen pixels (the process is per-monitor DPI
# aware); the Electron side converts with screen.screenToDipPoint.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KaashifyWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern long GetWindowLongPtrW(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO g);
  // The window's own answer about typing: { the caret's window, the focused child }, 0 for none.
  public static long[] Focus(IntPtr h) {
    uint pid; uint tid = GetWindowThreadProcessId(h, out pid);
    var g = new GUITHREADINFO(); g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (tid == 0 || !GetGUIThreadInfo(tid, ref g)) return new long[] { 0, 0 };
    return new long[] { g.hwndCaret.ToInt64(), g.hwndFocus.ToInt64() };
  }
  // The caret a browser or an Electron app draws itself is not a Windows caret;
  // those apps report it through the accessibility caret object instead (OBJID_CARET).
  [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IDispatch)] out object acc);
  public static object CaretObject(IntPtr h) {
    try { Guid iid = new Guid("00020400-0000-0000-C000-000000000046"); object o; if (AccessibleObjectFromWindow(h, 0xFFFFFFF8, ref iid, out o) != 0) return null; return o; } catch { return null; }
  }
  // The ordinary windows drawn over `target`: above it in the z-order, shown,
  // not minimised, not cloaked (another desktop, a suspended app), not topmost
  // themselves, and overlapping it. Returns { how many, the first one's
  // handle }, or { -1, 0 } when the target is not a top-level window.
  public static long[] Covering(IntPtr target) {
    RECT t; if (!GetWindowRect(target, out t)) return new long[] { -1, 0 };
    long n = 0, first = 0; int guard = 0;
    for (IntPtr h = GetTopWindow(IntPtr.Zero); h != IntPtr.Zero && guard++ < 5000; h = GetWindow(h, 2)) {
      if (h == target) return new long[] { n, first };
      if (!IsWindowVisible(h) || IsIconic(h)) continue;
      if ((GetWindowLongPtrW(h, -20) & 8) != 0) continue;
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) continue;
      RECT r; if (!GetWindowRect(h, out r)) continue;
      if (Math.Min(r.R, t.R) <= Math.Max(r.L, t.L) || Math.Min(r.B, t.B) <= Math.Max(r.T, t.T)) continue;
      if (n++ == 0) first = h.ToInt64();
    }
    return new long[] { -1, 0 };
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static int[] Rect(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return null; return new int[] { r.L, r.T, r.R, r.B }; }
  public static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  // Top-level window under a point, skipping windows owned by `ignorePid`
  // (the Companion's own transparent overlay covers the whole work area).
  public static IntPtr TopWindowAt(int x, int y, uint ignorePid) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return h;
    h = GetAncestor(h, 2);
    int guard = 0;
    while (h != IntPtr.Zero && guard++ < 512) {
      if (IsWindowVisible(h) && Pid(h) != ignorePid) {
        RECT r;
        if (GetWindowRect(h, out r) && x >= r.L && x < r.R && y >= r.T && y < r.B) return h;
      }
      h = GetWindow(h, 2);
    }
    return IntPtr.Zero;
  }
}
"@

try { [void][KaashifyWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][KaashifyWin]::SetProcessDPIAware() } catch {} }

Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.Add($AE::NameProperty)
$cache.Add($AE::ControlTypeProperty)
$cache.Add($AE::AutomationIdProperty)
$cache.Add($AE::BoundingRectangleProperty)
$cache.Add($AE::IsOffscreenProperty)
$cache.Add($AE::ProcessIdProperty)
$cache.Add($AE::IsPasswordProperty)
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element

# Controls a person can act on. Containers are descended, not reported.
$Interactive = @{
  'Button'=1; 'MenuItem'=1; 'TabItem'=1; 'Hyperlink'=1; 'Edit'=1; 'ComboBox'=1;
  'CheckBox'=1; 'RadioButton'=1; 'ListItem'=1; 'TreeItem'=1; 'Slider'=1;
  'SplitButton'=1; 'Spinner'=1; 'MenuBar'=0; 'Menu'=0
}
# Types that frame other controls: listed beside the elements (capped), so the
# guide can draw a region round the area a sentence names (guide/region.js).
$Containers = @{
  'Pane'=1; 'Group'=1; 'Document'=1; 'List'=1; 'Tree'=1; 'Table'=1; 'DataGrid'=1; 'ToolBar'=1; 'Tab'=1; 'Custom'=1
}
$ContainerMax = 60

function Out-Line($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Type-Name($el, $cached) {
  try {
    $ct = if ($cached) { $el.Cached.ControlType } else { $el.Current.ControlType }
    $n = $ct.ProgrammaticName
    if ($n -like 'ControlType.*') { return $n.Substring(12) }
    return $n
  } catch { return '' }
}

function Rect-Of($el, $cached) {
  try {
    $r = if ($cached) { $el.Cached.BoundingRectangle } else { $el.Current.BoundingRectangle }
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { return $null }
    if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y)) { return $null }
    return @{ x=[int][math]::Round($r.X); y=[int][math]::Round($r.Y); w=[int][math]::Round($r.Width); h=[int][math]::Round($r.Height) }
  } catch { return $null }
}

function Describe($el, $cached, $id) {
  $props = if ($cached) { $el.Cached } else { $el.Current }
  $name = ''; $auto = ''; $procId = 0; $pw = $false
  try { $name = [string]$props.Name } catch {}
  try { $auto = [string]$props.AutomationId } catch {}
  try { $procId = [int]$props.ProcessId } catch {}
  # A password box says so; the flag travels with the control and no value ever does.
  try { $pw = [bool]$props.IsPassword } catch {}
  return @{ id=$id; name=$name; type=(Type-Name $el $cached); automationId=$auto; rect=(Rect-Of $el $cached); pid=$procId; isPassword=$pw }
}

# The window the user is working in. When our own window (the overlay the
# user just clicked to type, or the Kaashify dashboard) is in front, walk down
# the z-order to the first visible, titled window that is not ours.
# Average brightness (0..1) of a small box of the screen. Used to keep Kaashify
# readable on light and dark desktops. Reads the pixels, returns one number,
# keeps nothing. With ring=1 only the box's outer cells count (Kaashify sits in
# the middle and must not measure itself).
function Get-Luma([int]$x, [int]$y, [int]$w, [int]$h, [int]$ring) {
  if (-not $script:drawingLoaded) { Add-Type -AssemblyName System.Drawing; $script:drawingLoaded = $true }
  $n = 8
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $small = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  try {
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $g2.DrawImage($bmp, 0, 0, $n, $n)
    $sum = 0.0; $count = 0
    for ($i = 0; $i -lt $n; $i++) { for ($j = 0; $j -lt $n; $j++) {
      if ($ring -and $i -gt 0 -and $i -lt ($n - 1) -and $j -gt 0 -and $j -lt ($n - 1)) { continue }
      $c = $small.GetPixel($i, $j)
      $sum += (0.2126 * $c.R + 0.7152 * $c.G + 0.0722 * $c.B) / 255.0
      $count++
    } }
    return @{ luma = [Math]::Round($sum / [Math]::Max(1, $count), 4) }
  } finally { $g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose() }
}

function Get-Foreground($ignore) {
  $h = [KaashifyWin]::GetForegroundWindow()
  $skipped = $false
  if ($ignore -and $h -ne [IntPtr]::Zero -and [KaashifyWin]::Pid($h) -eq [uint32]$ignore) {
    $skipped = $true
    $n = [KaashifyWin]::GetWindow($h, 2); $guard = 0
    while ($n -ne [IntPtr]::Zero -and $guard++ -lt 512) {
      if ([KaashifyWin]::IsWindowVisible($n) -and [KaashifyWin]::Pid($n) -ne [uint32]$ignore) {
        $t = [KaashifyWin]::Title($n)
        $rr = [KaashifyWin]::Rect($n)
        if ($t -and $t -ne 'Program Manager' -and $rr -and ($rr[2] - $rr[0]) -gt 120 -and ($rr[3] - $rr[1]) -gt 80) { $h = $n; break }
      }
      $n = [KaashifyWin]::GetWindow($n, 2)
    }
    if ($n -eq [IntPtr]::Zero -or $guard -ge 512) { $h = [IntPtr]::Zero }
  }
  if ($h -eq [IntPtr]::Zero) { return @{ hwnd=0; title=''; process=''; exe=''; pid=0; rect=$null; behindSelf=$skipped } }
  $procId = [KaashifyWin]::Pid($h)
  $proc = ''; $exe = ''
  try { $p = Get-Process -Id $procId -ErrorAction Stop; $proc = $p.ProcessName; try { $exe = $p.Path } catch {} } catch {}
  $r = [KaashifyWin]::Rect($h)
  $rect = $null
  if ($r) { $rect = @{ x=$r[0]; y=$r[1]; w=($r[2]-$r[0]); h=($r[3]-$r[1]) } }
  return @{ hwnd=[int64]$h; title=[KaashifyWin]::Title($h); process=$proc; exe=$exe; pid=[int]$procId; rect=$rect; behindSelf=$skipped }
}

# Depth-first walk of the control view under a window, bounded by count, depth
# and time. Returns interactive, on-screen elements in document order.
function Walk-Controls($hwnd, $max, $budgetMs, $workflow = $false) {
  $root = $AE::FromHandle([IntPtr][int64]$hwnd)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = New-Object System.Collections.ArrayList
  $containers = New-Object System.Collections.ArrayList
  $refs = @{}
  $stack = New-Object System.Collections.Stack
  $truncated = $false
  $first = $null
  try { $first = $walker.GetFirstChild($root, $cache) } catch { $first = $null }
  if ($first) { $stack.Push(@($first, 1)) }
  $seen = 0
  while ($stack.Count -gt 0) {
    if ($out.Count -ge $max -or $sw.ElapsedMilliseconds -gt $budgetMs) { $truncated = $true; break }
    $item = $stack.Pop(); $el = $item[0]; $depth = $item[1]
    $seen++
    $sib = $null
    try { $sib = $walker.GetNextSibling($el, $cache) } catch { $sib = $null }
    if ($sib) { $stack.Push(@($sib, $depth)) }
    $off = $false
    try { $off = [bool]$el.Cached.IsOffscreen } catch {}
    $type = Type-Name $el $true
    if (-not $off -and $Interactive.ContainsKey($type) -and $Interactive[$type] -eq 1) {
      $d = Describe $el $true ($out.Count + 1)
      if ($d.rect) {
        [void]$out.Add($d)
        if ($workflow) { $refs[$d.id] = $el }
      }
    } elseif (-not $off -and $depth -gt 1 -and $containers.Count -lt $ContainerMax -and $Containers.ContainsKey($type)) {
      $c = Describe $el $true (1000 + $containers.Count + 1)
      if ($c.rect -and $c.rect.w -gt 40 -and $c.rect.h -gt 24) {
        [void]$containers.Add($c)
        if ($workflow) { $refs[$c.id] = $el }
      }
    }
    if ($depth -lt 18 -and -not $off) {
      $child = $null
      try { $child = $walker.GetFirstChild($el, $cache) } catch { $child = $null }
      if ($child) { $stack.Push(@($child, $depth + 1)) }
    }
  }
  $result = @{ elements=@($out.ToArray()); containers=@($containers.ToArray()); truncated=$truncated; visited=$seen; ms=[int]$sw.ElapsedMilliseconds }
  if ($workflow) { $result.refs = $refs }
  return $result
}

function Score-Name($candidate, $want) {
  if (-not $candidate) { return 0 }
  $c = $candidate.Trim().ToLowerInvariant(); $w = $want.Trim().ToLowerInvariant()
  if ($c -eq $w) { return 100 }
  if ($c.StartsWith($w)) { return 80 }
  if ($c.Contains($w)) { return 60 }
  if ($w.Contains($c) -and $c.Length -ge 3) { return 40 }
  return 0
}

# {"id":8,"op":"ocr","path":"C:\\...\\frame.jpg"} -> {"text":"..."}
# The words on an image through the OCR engine built into Windows. Living in
# this long-lived process saves the half second a fresh PowerShell costs
# (assignment mode reads the screen on every settled change, 2026-09-21).
# With "words":true also where each word is, for drawing on the screen
# (src/guide/marks.js): adds width, height (the image's pixels) and words, one
# word per row "x y w h word" in image pixels, a blank row between lines.
$script:ocrEngine = $null
$script:ocrAsTask = $null
function Read-Words($path, [bool]$boxes = $false) {
  if (-not $script:ocrAsTask) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $script:ocrAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
      })[0]
    $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
  if (-not $script:ocrEngine) { return @{ error='no OCR language installed' } }
  $await = { param($op, [Type]$type) $t = $script:ocrAsTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $file    = & $await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream  = & $await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = & $await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap  = & $await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result  = & $await ($script:ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    if (-not $boxes) { return @{ text=[string]$result.Text } }
    $sb = New-Object System.Text.StringBuilder
    $inv = [Globalization.CultureInfo]::InvariantCulture
    foreach ($line in $result.Lines) {
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        $word = ([string]$w.Text) -replace '\s+', ' '
        [void]$sb.Append(([double]$r.X).ToString('0.#', $inv)).Append(' ').Append(([double]$r.Y).ToString('0.#', $inv)).Append(' ').Append(([double]$r.Width).ToString('0.#', $inv)).Append(' ').Append(([double]$r.Height).ToString('0.#', $inv)).Append(' ').Append($word).Append([char]10)
      }
      [void]$sb.Append([char]10)
    }
    return @{ text=[string]$result.Text; width=[int]$bitmap.PixelWidth; height=[int]$bitmap.PixelHeight; words=$sb.ToString() }
  } finally { $stream.Dispose() }
}

# The text selected in the front app, for "make this friendlier": UI
# Automation's text pattern on the focused control, or on the nearest parent
# that has one (a browser page, a Word document). Read-only like everything
# here. A password field is never read; text is capped at `max` characters.
# readOnly says the control will not take a paste (a plain web page).
function Get-Selection($ignore, [int]$max) {
  $el = $null
  try { $el = $AE::FocusedElement } catch { $el = $null }
  if (-not $el) { return @{ text=''; reason='no focus' } }
  try { if ($ignore -and [uint32]$el.Current.ProcessId -eq [uint32]$ignore) { return @{ text=''; reason='ours' } } } catch {}
  try { if ([bool]$el.Current.IsPassword) { return @{ text=''; refused='password' } } } catch {}
  $readOnly = $false
  try { $v = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($v) { $readOnly = [bool]$v.Current.IsReadOnly } } catch {}
  $raw = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $node = $el; $hops = 0; $text = ''; $found = $false
  while ($node -and $hops -lt 8) {
    $pat = $null
    try { $pat = $node.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch { $pat = $null }
    if ($pat) {
      $found = $true
      try {
        $sb = New-Object System.Text.StringBuilder
        foreach ($r in $pat.GetSelection()) {
          $left = $max - $sb.Length
          if ($left -le 0) { break }
          if ($sb.Length -gt 0) { [void]$sb.Append("`n") }
          [void]$sb.Append($r.GetText($left))
        }
        $text = $sb.ToString()
      } catch { $text = ''; $found = $false }   # the app could not say: the copy fallback may yet
      break
    }
    try { $node = $raw.GetParent($node) } catch { $node = $null }
    $hops++
  }
  if ($text.Length -gt $max) { $text = $text.Substring(0, $max) }
  return @{ text=$text; pattern=$found; readOnly=$readOnly; type=(Type-Name $el $false); truncated=($text.Length -ge $max) }
}

# The words of the front window, for "summarize this page" and "read me the
# assignment": every control with a text pattern (a web page, a Word or PDF
# document, a text box) gives its whole text; with none, the names of the
# window's Text controls are used. Read-only. Password fields are never read.
# Capped at `max` characters and `budgetMs` of walking.
$textCache = New-Object System.Windows.Automation.CacheRequest
$textCache.Add($AE::NameProperty)
$textCache.Add($AE::ControlTypeProperty)
$textCache.Add($AE::IsPasswordProperty)
$textCache.Add($AE::ProcessIdProperty)
$textCache.Add($AE::IsTextPatternAvailableProperty)
$textCache.TreeScope = [System.Windows.Automation.TreeScope]::Element
function Get-WindowText($hwnd, [int]$max, [int]$budgetMs, $ignore) {
  $root = $AE::FromHandle([IntPtr][int64]$hwnd)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $docs = New-Object System.Text.StringBuilder
  $names = New-Object System.Text.StringBuilder
  $stack = New-Object System.Collections.Stack
  $sources = 0; $skipped = 0; $truncated = $false
  $first = $null
  try { $first = $walker.GetFirstChild($root, $textCache) } catch { $first = $null }
  # The window itself may be the document (a plain edit window).
  try { $rootEl = $root.GetUpdatedCache($textCache); $stack.Push(@($rootEl, 0, $true)) } catch { if ($first) { $stack.Push(@($first, 1, $false)) } }
  while ($stack.Count -gt 0) {
    if ($sw.ElapsedMilliseconds -gt $budgetMs) { $truncated = $true; break }
    if (($docs.Length + $names.Length) -ge $max) { $truncated = $true; break }
    $item = $stack.Pop(); $el = $item[0]; $depth = $item[1]; $isRoot = $item[2]
    if (-not $isRoot) {
      $sib = $null
      try { $sib = $walker.GetNextSibling($el, $textCache) } catch { $sib = $null }
      if ($sib) { $stack.Push(@($sib, $depth, $false)) }
    }
    $pw = $false; $proc = 0
    try { $pw = [bool]$el.Cached.IsPassword } catch {}
    try { $proc = [int]$el.Cached.ProcessId } catch {}
    if ($pw) { $skipped++; continue }
    if ($ignore -and $proc -eq [int]$ignore) { continue }
    $hasText = $false
    try { $hasText = [bool]$el.GetCachedPropertyValue($AE::IsTextPatternAvailableProperty) } catch { $hasText = $false }
    if ($hasText) {
      try {
        $pat = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        $left = $max - $docs.Length
        if ($left -gt 0) {
          $t = [string]$pat.DocumentRange.GetText($left)
          if ($t.Trim().Length -gt 0) { if ($docs.Length -gt 0) { [void]$docs.Append("`n`n") }; [void]$docs.Append($t); $sources++ }
        }
        continue
      } catch {}
    }
    if ((Type-Name $el $true) -eq 'Text') {
      $n = ''
      try { $n = [string]$el.Cached.Name } catch {}
      if ($n.Trim().Length -gt 0 -and $names.Length -lt $max) { [void]$names.Append($n.Trim()); [void]$names.Append("`n") }
    }
    if ($depth -lt 30) {
      $child = $null
      try { $child = $walker.GetFirstChild($el, $textCache) } catch { $child = $null }
      if ($child) { $stack.Push(@($child, ($depth + 1), $false)) }
    }
  }
  $text = if ($docs.Length -gt 0) { $docs.ToString() } else { $names.ToString() }
  if ($text.Length -gt $max) { $text = $text.Substring(0, $max); $truncated = $true }
  return @{ text=$text; from=$(if ($docs.Length -gt 0) { 'document' } else { 'labels' }); sources=$sources; passwordsSkipped=$skipped; truncated=$truncated; ms=[int]$sw.ElapsedMilliseconds; hwnd=[int64]$hwnd; title=[KaashifyWin]::Title([IntPtr][int64]$hwnd) }
}

# The workflow side never accepts a screen coordinate or arbitrary shortcut.
# Runtime IDs bind every mutation to a live accessibility control.
function Workflow-Id($el) {
  try { return ($el.GetRuntimeId() -join ',') } catch { return '' }
}

function Workflow-Pattern($el, $pattern) {
  try {
    $value = $null
    if ($el.TryGetCurrentPattern($pattern, [ref]$value)) { return $value }
  } catch {}
  return $null
}

function Workflow-Private($name) {
  return [string]$name -match '\b(password|passcode|captcha|pin|otp|cvv|cvc|passport|security (code|question)|card number|bank account|identity number|tax id|social security|one.time code)\b'
}

function Workflow-Attributes($el, $control, $browser) {
  $control.rid = Workflow-Id $el
  $control.enabled = $false
  $control.web = $false
  $control.group = ''
  $control.required = $false
  $control.selected = $false
  $control.filled = $false
  try {
    $control.enabled = [bool]$el.Current.IsEnabled
    $control.required = [bool]$el.Current.IsRequiredForForm
  } catch {}
  try {
    $label = $el.Current.LabeledBy
    if ($label -and $label.Current.Name) { $control.group = [string]$label.Current.Name }
  } catch {}
  $raw = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $parent = $el
  for ($n = 0; $n -lt 18; $n++) {
    try { $parent = $raw.GetParent($parent) } catch { break }
    if (-not $parent) { break }
    $kind = Type-Name $parent $false
    if ($kind -eq 'Document') { $control.web = $browser; break }
    if ($kind -eq 'Window') { break }
    if (-not $control.group -and $kind -in @('Group','List','ComboBox')) {
      try {
        $control.group = [string]$parent.Current.Name
        if ($parent.Current.IsRequiredForForm) { $control.required = $true }
      } catch {}
    }
  }
  try {
    $selection = Workflow-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($selection) { $control.selected = [bool]$selection.Current.IsSelected }
    $toggle = Workflow-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($toggle) { $control.selected = [string]$toggle.Current.ToggleState -eq 'On' }
    if ($control.type -eq 'Edit' -and -not $control.isPassword -and -not (Workflow-Private ($control.name + ' ' + $control.group))) {
      $vp = Workflow-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { $control.filled = -not [string]::IsNullOrWhiteSpace([string]$vp.Current.Value) }
    }
  } catch {}
}

function Workflow-Snapshot {
  $front = Get-Foreground 0
  $out = @{ fg=$front; controls=@(); url=''; tab=''; view=''; recipients=''; selection=''; editor=''; emptyDocument=$false; live=@{} }
  if (-not $front.hwnd -or $front.process -notin @('chrome','msedge','outlook','olk','notepad','winword')) { return $out }
  $browser = $front.process -in @('chrome','msedge')
  $walk = Walk-Controls $front.hwnd 180 1500 $true
  $controls = @($walk.elements) + @($walk.containers | Where-Object { $_.type -eq 'Document' })
  foreach ($c in $controls) {
    $el = $walk.refs[$c.id]
    Workflow-Attributes $el $c $browser
    if (-not $c.rid) { continue }
    $out.live[$c.rid] = $el
    if ($c.type -eq 'TabItem' -and $c.selected -and -not $c.web -and -not $out.tab) { $out.tab = $c.rid }
    if ($browser -and -not $c.web) {
      if ($c.type -eq 'Edit' -and ($c.automationId -eq 'addressEditBox' -or $c.name -match '^Address and search bar$')) {
        $vp = Workflow-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp) {
          $address = ([string]$vp.Current.Value).Trim()
          if ($address -match '^https?://') { $out.url = $address }
          elseif ($address -match '^[a-z0-9.-]+\.[a-z]{2,}(?::[0-9]+)?(?:[/#?]|$)') { $out.url = 'https://' + $address }
        }
      }
      if ($c.type -eq 'Document' -and -not $out.view) { $out.view = $c.rid }
    }
    if (($browser -and $c.web -or $front.process -in @('outlook','olk')) -and $c.type -in @('Button','ListItem','Group') -and
        ($c.group -match '^(to|recipients?|to recipients?):?$' -or $c.name -match '^remove recipient')) {
      $out.recipients += ' ' + $c.name
    }
  }
  if ($front.process -in @('notepad','winword')) {
    $docs = @($controls | Where-Object {
      $_.rid -and -not $_.isPassword -and
      ($_.type -eq 'Document' -or ($_.type -eq 'Edit' -and ($_.name -match '^(Text editor|Document|Editing area)$' -or $_.automationId -eq '15')))
    })
    try {
      $focusId = Workflow-Id ($AE::FocusedElement)
      $docs = @($docs | Sort-Object { if ($_.rid -eq $focusId) { 0 } elseif ($_.type -eq 'Document') { 1 } else { 2 } })
    } catch {}
    foreach ($c in $docs) {
      $doc = $out.live[$c.rid]
      $pattern = Workflow-Pattern $doc ([System.Windows.Automation.TextPattern]::Pattern)
      if (-not $pattern) { continue }
      try {
        $out.view = $c.rid + '|' + $front.title
        $out.editor = $c.rid
        $out.emptyDocument = [string]::IsNullOrWhiteSpace($pattern.DocumentRange.GetText(10001))
        $selected = @($pattern.GetSelection())
        if ($selected.Count -eq 1) {
          $text = $selected[0].GetText(10001)
          if ($text.Length -le 10000) { $out.selection = $text }
        }
        break
      } catch {}
    }
  }
  $out.controls = @($controls | Where-Object { $_.rid })
  if ([KaashifyWin]::GetForegroundWindow().ToInt64() -ne $front.hwnd) {
    return @{ fg=$null; controls=@(); live=@{}; url=''; view=''; tab='' }
  }
  return $out
}

function Workflow-TargetMatches($snap, $want) {
  if (-not $snap.fg -or -not $want.hwnd -or -not $want.pid) { return $false }
  return ($snap.fg.hwnd -eq $want.hwnd -and $snap.fg.pid -eq $want.pid -and
          [string]$snap.tab -ceq [string]$want.tab -and [string]$snap.view -ceq [string]$want.view -and
          [string]$snap.url -ceq [string]$want.url -and
          [KaashifyWin]::GetForegroundWindow().ToInt64() -eq $want.hwnd)
}

function Workflow-Edit($req) {
  $s = Workflow-Snapshot
  $deadline = [int64]$req.deadline
  if (-not (Workflow-TargetMatches $s $req.target) -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt $deadline) { return @{ok=$false; reason='focus'} }
  $mode = [string]$req.kind
  $op = [string]$req.action
  $browser = $s.fg.process -in @('chrome','msedge')
  if ($op -eq 'scroll' -and $mode -eq 'survey' -and $browser) {
    foreach ($c in @($s.controls | Where-Object { $_.type -eq 'Document' })) {
      $scroll = Workflow-Pattern $s.live[$c.rid] ([System.Windows.Automation.ScrollPattern]::Pattern)
      if ($scroll -and $scroll.Current.VerticallyScrollable -and $scroll.Current.VerticalScrollPercent -lt 100) {
        $scroll.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::LargeIncrement)
        return @{ok=$true}
      }
    }
    return @{ok=$false; reason='no-scroll'}
  }
  $rid = [string]$req.control.rid
  $control = @($s.controls | Where-Object { $_.rid -ceq $rid -and $_.name -ceq $req.control.name -and $_.type -ceq $req.control.type -and [string]$_.group -ceq [string]$req.control.group })
  if ($control.Count -ne 1) { return @{ok=$false; reason='control'} }
  $c = $control[0]
  $el = $s.live[$rid]
  if (-not $c.enabled -or $c.isPassword -or (Workflow-Private ($c.name + ' ' + $c.group))) { return @{ok=$false; reason='control'} }
  $isMail = $browser -or $s.fg.process -in @('outlook','olk')
  if ($browser -and -not $c.web) { return @{ok=$false; reason='control'} }
  if ($op -eq 'document-focus' -and $mode -eq 'document' -and $c.rid -eq $s.editor -and $s.fg.process -in @('notepad','winword')) {
    $el.SetFocus()
    return @{ok=((Workflow-Id ($AE::FocusedElement)) -ceq $rid); reason='focus'}
  }
  if ($op -eq 'next' -or $op -eq 'compose') {
    $safe = ($op -eq 'next' -and $mode -eq 'survey' -and $browser -and $c.name -match '^(Next|Next page|Continue to next (page|section))$') -or
            ($op -eq 'compose' -and $mode -eq 'email' -and $isMail -and $c.name -match '^(Compose|New mail|New message|New e-mail|New email)$')
    $invoker = Workflow-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
    if (-not $safe -or $c.type -ne 'Button' -or -not $invoker) { return @{ok=$false; reason='control'} }
    $invoker.Invoke()
    return @{ok=$true}
  }
  $value = [string]$req.value
  if ($op -eq 'commit-recipient' -and $mode -eq 'email' -and $isMail -and $c.type -in @('ListItem','MenuItem','Button')) {
    if ($c.name -match '^(send|submit|compose|message|email to)\b') { return @{ok=$false; reason='control'} }
    if ($value -notmatch '^[^\s@]+@[^\s@]+\.[a-z]{2,}$' -or
        $c.name -notmatch ('(?:^|[<(,\s])' + [regex]::Escape($value) + '(?:$|[>),\s])')) { return @{ok=$false; reason='control'} }
    if ($c.type -eq 'Button' -and $c.name -notmatch '^(Add recipient|Add address)\b') { return @{ok=$false; reason='control'} }
    $invoker = Workflow-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
    if (-not $invoker) { return @{ok=$false; reason='control'} }
    $invoker.Invoke()
    return @{ok=$true}
  }
  if ($value.Length -eq 0 -or $value.Length -gt 10000) { return @{ok=$false; reason='value'} }
  if ($op -eq 'email-field' -and $mode -eq 'email' -and $isMail) {
    $label = [string]$c.name
    $ok = ($req.field -eq 'to' -and $c.type -eq 'Edit' -and $label -match '^(To:?|To recipients?|Recipients?|Add recipients?|Enter recipients?)$') -or
          ($req.field -eq 'subject' -and $c.type -eq 'Edit' -and $label -match '^(Add a subject|Subject:?)$') -or
          ($req.field -eq 'body' -and $c.type -in @('Edit','Document') -and $label -match '^(Message body|Email body|Body|Message|Compose email|Message content)$')
    if (-not $ok) { return @{ok=$false; reason='control'} }
  } elseif ($mode -ne 'survey' -or -not $browser) { return @{ok=$false; reason='control'} }
  if (($op -eq 'field' -and $c.type -eq 'Edit') -or $op -eq 'email-field') {
    $vp = Workflow-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $vp -or $vp.Current.IsReadOnly) {
      if ($op -ne 'email-field' -or $req.field -ne 'body') { return @{ok=$false; reason='control'} }
      $el.SetFocus()
      if ((Workflow-Id ($AE::FocusedElement)) -ceq $rid) { return @{ok=$false; reason='paste-needed'; rid=$rid} }
      return @{ok=$false; reason='control'}
    }
    $before = [string]$vp.Current.Value
    if ($before -ceq $value) { return @{ok=$true} }
    if (($op -eq 'field' -or $req.field -eq 'to') -and -not [string]::IsNullOrWhiteSpace($before)) { return @{ok=$false; reason='filled'} }
    $vp.SetValue($value)
    return @{ok=([string]$vp.Current.Value -ceq $value); reason='unverified'}
  }
  if ($op -eq 'choose' -and $value.Trim() -match '^(send|submit|finish|complete|turn in|hand in)( (this |the )?(e-?mail|message|survey|form|responses?))?$') {
    return @{ok=$false; reason='control'}
  }
  if ($op -eq 'choose' -and $c.type -in @('RadioButton','CheckBox','ListItem','ComboBox')) {
    if ($c.type -eq 'ComboBox') {
      $expand = Workflow-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($expand -and [string]$expand.Current.ExpandCollapseState -eq 'Collapsed') { $expand.Expand() }
      $listItem = New-Object System.Windows.Automation.PropertyCondition ($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
      $opts = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listItem)
      $matching = @($opts | Where-Object { $_.Current.Name -ieq $value -and $_.Current.IsEnabled })
      if ($matching.Count -ne 1) { return @{ok=$false; reason='control'} }
      $el = $matching[0]
    } elseif ($c.name -ine $value) { return @{ok=$false; reason='value'} }
    $item = Workflow-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($item) {
      if (-not $item.Current.IsSelected) { $item.Select() }
      return @{ok=[bool]$item.Current.IsSelected; reason='unverified'}
    }
    $toggle = Workflow-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($toggle -and $c.type -eq 'CheckBox') {
      if ([string]$toggle.Current.ToggleState -eq 'Off') { $toggle.Toggle() }
      return @{ok=([string]$toggle.Current.ToggleState -eq 'On'); reason='unverified'}
    }
  }
  return @{ok=$false; reason='control'}
}

function Handle($req) {
  $op = [string]$req.op
  switch ($op) {
    'workflow.read' { $w = Workflow-Snapshot; $w.Remove('live'); return $w }
    'workflow.edit' { return Workflow-Edit $req }
    'ping' { return @{ ok=$true; pid=$PID; ps=$PSVersionTable.PSVersion.ToString() } }
    'ocr' {
      try { return Read-Words ([string]$req.path) ([bool]$req.words) }
      catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; return @{ error=('ocr: ' + $e.Message) } }
    }
    'fg' { $ig = if ($req.ignorePid) { [uint32]$req.ignorePid } else { 0 }; return Get-Foreground $ig }
    'cursor' { $c = [KaashifyWin]::Cursor(); return @{ x=$c[0]; y=$c[1] } }
    'screen.luma' {
      try { return Get-Luma ([int][double]$req.x) ([int][double]$req.y) ([Math]::Max(8, [int][double]$req.w)) ([Math]::Max(8, [int][double]$req.h)) ([int][bool]$req.ring) }
      catch { return @{ error=('luma: ' + $_.Exception.Message) } }
    }
    'win.topmost' {
      # Put a window back above everything without activating it. Chromium refuses
      # HWND_TOPMOST from inside the app while a monitor-sized window is up (measured
      # 2026-09-10); an external SetWindowPos from this process is honoured.
      $h = [IntPtr][int64]$req.hwnd
      $ok = [KaashifyWin]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, [uint32](0x0001 -bor 0x0002 -bor 0x0010))
      $ex = [KaashifyWin]::GetWindowLongPtrW($h, -20)
      return @{ ok=[bool]$ok; topmost=(($ex -band 8) -ne 0) }
    }
    'win.covered' {
      # Is this window really on top? Windows can leave the topmost flag on a
      # window and still draw ordinary windows over it (found 2026-11-20: the
      # overlay sat under eleven windows with the flag set, so the flag check saw
      # nothing wrong). This counts what is drawn over it, and with raise it
      # lifts the window back, unless the one on top is `unless`: a window a
      # lift did not get above last time.
      $h = [IntPtr][int64]$req.hwnd
      $c = [KaashifyWin]::Covering($h)
      $ex = [KaashifyWin]::GetWindowLongPtrW($h, -20)
      $out = @{ ok=$true; above=$c[0]; first=$c[1]; topmost=(($ex -band 8) -ne 0); raised=$false }
      if ($c[0] -gt 0) {
        $out.firstClass = [KaashifyWin]::ClassOf([IntPtr]$c[1])
        $unless = if ($req.unless) { [int64]$req.unless } else { 0 }
        if ($req.raise -and $c[1] -ne $unless) {
          $out.raised = [bool][KaashifyWin]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, [uint32](0x0001 -bor 0x0002 -bor 0x0010))
          $left = [KaashifyWin]::Covering($h)
          $out.left = $left[0]; $out.leftFirst = $left[1]
        }
      }
      return $out
    }
    'uia.list' {
      $max = if ($req.max) { [int]$req.max } else { 150 }
      $budget = if ($req.budgetMs) { [int]$req.budgetMs } else { 1200 }
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][KaashifyWin]::GetForegroundWindow() }
      $r = Walk-Controls $hwnd $max $budget
      $r.hwnd = $hwnd
      return $r
    }
    'uia.frompoint' {
      $x = [int][double]$req.x; $y = [int][double]$req.y
      $ignore = if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 }
      # The window under the point, never our own overlay. Then the smallest
      # interactive control in that window containing the point: a text run
      # or image inside a button is not the control, the button is.
      $h = [KaashifyWin]::TopWindowAt($x, $y, $ignore)
      if ($h -eq [IntPtr]::Zero) { return @{ element=$null; hwnd=0 } }
      $budget = if ($req.budgetMs) { [int]$req.budgetMs } else { 900 }
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      # Hit test first, then climb to the nearest interactive ancestor: a few
      # UIA calls instead of a walk of the whole window (live 2026-11-02: the
      # walk over a Firefox page took longer than its 2.5 s timeout, and a held
      # Ctrl+Shift+T queued a hundred of them).
      $best = $null
      try {
        $pt = New-Object System.Windows.Point ([double]$x), ([double]$y)
        $el = $AE::FromPoint($pt)
        $depth = 0
        while ($el -and $depth -lt 8) {
          $t = Type-Name $el $false
          $procId = 0; try { $procId = [int]$el.Current.ProcessId } catch {}
          if ($procId -eq $ignore -and $ignore -ne 0) { $el = $null; break }
          if ($Interactive.ContainsKey($t) -and $Interactive[$t] -eq 1) { break }
          if ($t -eq 'Window' -or $t -eq 'Pane' -and $depth -gt 2) { $el = $null; break }
          $el = $walker.GetParent($el)
          $depth++
        }
        # A hit the size of the page (a Group or Document root) is not a control.
        if ($el) { $d = Describe $el $false 0; if ($d.rect -and $d.pid -ne $ignore -and ([double]$d.rect.w * [double]$d.rect.h) -lt 240000) { $best = $d } }
      } catch {}
      if ($best) { return @{ element=$best; hwnd=[int64]$h; window=@{ title=[KaashifyWin]::Title($h); pid=[int][KaashifyWin]::Pid($h) }; searched=1; truncated=$false; ms=[int]$sw.ElapsedMilliseconds } }
      # No interactive control above the hit: the old walk, within the budget
      # that is left.
      $left = [Math]::Max(150, $budget - [int]$sw.ElapsedMilliseconds)
      $r = Walk-Controls ([int64]$h) 400 $left
      $best = $null; $bestArea = [double]::MaxValue
      foreach ($e in $r.elements) {
        $rc = $e.rect
        if ($rc -and $x -ge $rc.x -and $x -lt ($rc.x + $rc.w) -and $y -ge $rc.y -and $y -lt ($rc.y + $rc.h)) {
          $area = [double]$rc.w * [double]$rc.h
          if ($area -lt $bestArea) { $best = $e; $bestArea = $area }
        }
      }
      if (-not $best) {
        # Nothing interactive contains the point: fall back to UIA's own hit
        # test, as long as it is not our overlay.
        try {
          $pt = New-Object System.Windows.Point ([double]$x), ([double]$y)
          $el = $AE::FromPoint($pt)
          if ($el) { $d = Describe $el $false 0; if ($d.pid -ne $ignore -and $d.rect) { $best = $d; $best.fallback = $true } }
        } catch {}
      }
      return @{ element=$best; hwnd=[int64]$h; window=@{ title=[KaashifyWin]::Title($h); pid=[int][KaashifyWin]::Pid($h) }; searched=$r.elements.Count; truncated=$r.truncated; ms=$r.ms }
    }
    'uia.focused' {
      # The control with keyboard focus: name, type, rect and whether it is a
      # password field. Read-only; a password field's value is never read.
      $ignore = if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 }
      try {
        $f = $AE::FocusedElement
        if (-not $f) { return @{ element=$null } }
        $d = Describe $f $false 0
        if ($ignore -ne 0 -and $d.pid -eq $ignore) { return @{ element=$null; ours=$true } }
        $pw = $false; try { $pw = [bool]$f.Current.IsPassword } catch {}
        return @{ element=@{ name=$d.name; type=$d.type; rect=$d.rect; isPassword=$pw; pid=$d.pid } }
      } catch { return @{ element=$null; error=[string]$_.Exception.Message } }
    }
    'focus.text' {
      # Can words be typed where the keyboard focus is? Facts only, read-only,
      # no value is ever read: the window's class, whether it shows a caret,
      # and what the focused control says about itself. src/dictate.js
      # (focusTakesText) decides; dictation asks this as Ctrl + Win goes down.
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $ignore = if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 }
      $h = [KaashifyWin]::GetForegroundWindow()
      $out = @{ hwnd=[int64]$h; cls=''; pid=0; ours=$false; caret=$false; focusCls=''; type=''; password=$false; hasValue=$false; readOnly=$null; hasText=$false; textReadOnly=$null }
      if ($h -ne [IntPtr]::Zero) {
        $out.cls = [KaashifyWin]::ClassOf($h); $out.pid = [int][KaashifyWin]::Pid($h)
        if ($ignore -ne 0 -and [uint32]$out.pid -eq $ignore) { $out.ours = $true }
        else {
          $hf = $h
          try { $g = [KaashifyWin]::Focus($h); $out.caret = ($g[0] -ne 0); if ($g[1] -ne 0) { $hf = [IntPtr]$g[1]; $out.focusCls = [KaashifyWin]::ClassOf($hf) } } catch {}
          if (-not $out.caret) {
            try {
              $c = [KaashifyWin]::CaretObject($hf)
              if ($c) { $cx = 0; $cy = 0; $cw = 0; $ch = 0; $c.accLocation([ref]$cx, [ref]$cy, [ref]$cw, [ref]$ch, 0); if ($ch -gt 0) { $out.caret = $true; $out.caretVia = 'acc' } }
            } catch {}
          }
          try {
            $f = $AE::FocusedElement
            if ($f) {
              $out.type = Type-Name $f $false
              try { $out.password = [bool]$f.Current.IsPassword } catch {}
              $vp = $null
              if ($f.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $out.hasValue = $true; try { $out.readOnly = [bool]$vp.Current.IsReadOnly } catch {} }
              $tp = $null
              if ($f.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
                $out.hasText = $true
                try { $ro = $tp.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute); if ($ro -is [bool]) { $out.textReadOnly = [bool]$ro } } catch {}
              }
            }
          } catch { $out.error = [string]$_.Exception.Message }
        }
      }
      $out.ms = [int]$sw.ElapsedMilliseconds
      return $out
    }
    'uia.text' {
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][KaashifyWin]::GetForegroundWindow() }
      $max = if ($req.max) { [Math]::Max(1000, [Math]::Min(400000, [int]$req.max)) } else { 200000 }
      $budget = if ($req.budgetMs) { [Math]::Max(200, [Math]::Min(8000, [int]$req.budgetMs)) } else { 2500 }
      $ig = if ($req.ignorePid) { [int]$req.ignorePid } else { 0 }
      return Get-WindowText $hwnd $max $budget $ig
    }
    'uia.selection' {
      $ig = if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 }
      $max = if ($req.max) { [Math]::Max(1, [Math]::Min(40000, [int]$req.max)) } else { 20000 }
      return Get-Selection $ig $max
    }
    'uia.find' {
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][KaashifyWin]::GetForegroundWindow() }
      $want = [string]$req.name
      $type = [string]$req.type
      $r = Walk-Controls $hwnd 400 1500
      $best = $null; $bestScore = 0
      foreach ($e in $r.elements) {
        $s = Score-Name $e.name $want
        if ($s -gt 0 -and $type -and $e.type -eq $type) { $s += 15 }
        if ($s -gt $bestScore) { $best = $e; $bestScore = $s }
      }
      return @{ element=$best; score=$bestScore; searched=$r.elements.Count; truncated=$r.truncated }
    }
    'watch.start' {
      $script:watch = @{
        keys = @(); click = [bool]$req.click; fg = [bool]$req.fg;
        prevKeys = @{}; prevClick = $false; downAt = $null; lastFg = 0; lastFgAt = 0
      }
      if ($req.keys) { $script:watch.keys = @($req.keys | ForEach-Object { [int]$_ }) }
      foreach ($k in $script:watch.keys) { $script:watch.prevKeys[$k] = [KaashifyWin]::Down($k) }
      $script:watch.prevClick = [KaashifyWin]::Down(1)
      $script:watch.lastFg = [int64][KaashifyWin]::GetForegroundWindow()
      return @{ ok=$true; watching=$true }
    }
    'watch.stop' { $script:watch = $null; return @{ ok=$true; watching=$false } }
    # The Start menu, for the reflex layer's app list. Read-only like everything here;
    # the keys are pressed by a separate sidecar (src/reflex/hands.ps1).
    'apps.list' {
      $apps = @(Get-StartApps | ForEach-Object { @{ name=[string]$_.Name; appId=[string]$_.AppID } })
      return @{ apps=$apps }
    }
    # Is a window of this app open at all? For the focus guard's "until I close
    # Word": read-only, the same name match the hands use to activate one.
    'win.find' {
      $want = ([string]$req.name).ToLowerInvariant() -replace '[^a-z0-9]', ''
      if ($want.Length -lt 2) { return @{ found=$false; error='name too short' } }
      $hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID } | Where-Object {
        $p = $_.ProcessName.ToLowerInvariant() -replace '[^a-z0-9]', ''
        $t = ([string]$_.MainWindowTitle).ToLowerInvariant() -replace '[^a-z0-9]', ''
        ($p.Length -ge 2 -and ($want.Contains($p) -or $p.Contains($want))) -or $t.EndsWith($want) -or $t.Contains($want)
      } | Select-Object -First 1
      if (-not $hit) { return @{ found=$false } }
      return @{ found=$true; process=$hit.ProcessName; title=[string]$hit.MainWindowTitle; hwnd=[int64]$hit.MainWindowHandle }
    }
    # The open windows, for a project that is resuming: called only then, and
    # main keeps only the ones that are already the project's own.
    'win.list' {
      $ig = if ($req.ignorePid) { [uint32]$req.ignorePid } else { 0 }
      $out = New-Object System.Collections.ArrayList
      $names = @{}
      $n = [KaashifyWin]::GetWindow([KaashifyWin]::GetForegroundWindow(), 0); $guard = 0
      while ($n -ne [IntPtr]::Zero -and $guard++ -lt 512 -and $out.Count -lt 64) {
        if ([KaashifyWin]::IsWindowVisible($n)) {
          $wp = [KaashifyWin]::Pid($n)
          $t = [KaashifyWin]::Title($n)
          $rr = [KaashifyWin]::Rect($n)
          if ($wp -ne $ig -and $t -and $t -ne 'Program Manager' -and $rr -and $rr[0] -gt -30000 -and ($rr[2] - $rr[0]) -gt 120 -and ($rr[3] - $rr[1]) -gt 80) {
            if (-not $names.ContainsKey($wp)) { try { $names[$wp] = (Get-Process -Id $wp -ErrorAction Stop).ProcessName } catch { $names[$wp] = '' } }
            [void]$out.Add(@{ title=$t; process=$names[$wp]; rect=@{ x=$rr[0]; y=$rr[1]; w=($rr[2]-$rr[0]); h=($rr[3]-$rr[1]) } })
          }
        }
        $n = [KaashifyWin]::GetWindow($n, 2)
      }
      return @{ windows=$out.ToArray() }
    }
    default { return @{ error=('unknown op ' + $op) } }
  }
}

function Poll-Watch() {
  $w = $script:watch
  if (-not $w) { return }
  if ($w.click) {
    $down = [KaashifyWin]::Down(1)
    if ($down -and -not $w.prevClick) { $w.downAt = [KaashifyWin]::Cursor() }
    if (-not $down -and $w.prevClick) {
      $c = if ($w.downAt) { $w.downAt } else { [KaashifyWin]::Cursor() }
      Out-Line @{ ev='click'; x=$c[0]; y=$c[1]; t=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
      $w.downAt = $null
    }
    $w.prevClick = $down
  }
  foreach ($k in $w.keys) {
    $d = [KaashifyWin]::Down($k)
    if ($d -ne $w.prevKeys[$k]) { $w.prevKeys[$k] = $d; Out-Line @{ ev='key'; vk=$k; down=$d } }
  }
  if ($w.fg) {
    $now = [Environment]::TickCount
    if ($now - $w.lastFgAt -ge 500) {
      $w.lastFgAt = $now
      $h = [int64][KaashifyWin]::GetForegroundWindow()
      if ($h -ne $w.lastFg) {
        $w.lastFg = $h
        $f = Get-Foreground 0; $f.ev = 'fg'
        Out-Line $f
      }
    }
  }
}

$script:watch = $null
$stdin = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
Out-Line @{ ev='ready'; pid=$PID }
$task = $reader.ReadLineAsync()
while ($true) {
  if ($task.IsCompleted) {
    $line = $task.Result
    if ($null -eq $line) { break }
    if ($line.Trim().Length -gt 0) {
      $id = $null
      try {
        $req = ConvertFrom-Json -InputObject $line
        $id = $req.id
        $res = Handle $req
        $res.id = $id
        Out-Line $res
      } catch {
        Out-Line @{ id=$id; error=[string]$_.Exception.Message }
      }
    }
    $task = $reader.ReadLineAsync()
  }
  if ($script:watch) {
    try { Poll-Watch } catch { Out-Line @{ ev='error'; message=[string]$_.Exception.Message } }
    Start-Sleep -Milliseconds 16
  } else {
    [void]$task.Wait(200)
  }
}
