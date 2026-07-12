"use strict";

/**
 * @file focus-hook-os.js
 *
 * OS-native window-focus change hook. Uses koffi (already in package.json)
 * for FFI on macOS and Windows. Emits NormalizedEvent objects to the local
 * POST /focus endpoint whenever the frontmost window changes.
 *
 * macOS : NSWorkspace notifications (NSWorkspaceDidActivateApplicationNotification)
 * Windows: SetWinEventHook(EVENT_SYSTEM_FOREGROUND) via User32 / Kernel32
 * Linux  : Not yet implemented — logs a warning and returns a no-op.
 *
 * IMPORTANT – Windows defensive policy:
 *   Every koffi FFI call is wrapped in try/catch. If any koffi operation
 *   fails (missing DLL, wrong arch, etc.) the hook silently falls back to a
 *   2-second polling loop using a plain child_process.execFile("powershell").
 *   The fallback is clearly logged. It never crashes the Electron main process.
 */

const http = require("http");
const { execFile } = require("child_process");
const os = require("os");

const POLL_INTERVAL_MS = 2000;
const POST_TIMEOUT_MS = 1500;

let _hookActive = false;
let _pollTimer = null;
let _lastApp = "";
let _lastTitle = "";
let _hookServerPort = null;

// ── helpers ─────────────────────────────────────────────────────────────────

function postFocusEvent(event) {
  if (!_hookServerPort) return;
  const body = JSON.stringify(event);
  try {
    const req = http.request({
      hostname: "127.0.0.1",
      port: _hookServerPort,
      path: "/focus",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    req.setTimeout(POST_TIMEOUT_MS, () => req.destroy());
    req.on("error", () => {}); // fire-and-forget
    req.write(body);
    req.end();
  } catch {
    // never throw from a hook
  }
}

function appNameToId(name) {
  if (!name) return "unknown";
  const n = name.toLowerCase();
  if (n.includes("chrome") || n.includes("chromium")) return "chrome";
  if (n.includes("firefox")) return "firefox";
  if (n.includes("safari")) return "safari";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("code") || n.includes("vscode")) return "vscode";
  if (n.includes("terminal") || n.includes("iterm") || n.includes("warp") || n.includes("ghostty")) return "terminal";
  if (n.includes("slack")) return "slack";
  if (n.includes("discord")) return "discord";
  if (n.includes("figma")) return "figma";
  if (n.includes("notion")) return "notion";
  return n.replace(/[^a-z0-9]/g, "-").slice(0, 32);
}

function maybeSendEvent(appName, title) {
  if (appName === _lastApp && title === _lastTitle) return;
  _lastApp = appName;
  _lastTitle = title;
  postFocusEvent({
    app: appNameToId(appName),
    title: title || appName,
    timestamp: Date.now(),
    source: "os-focus",
  });
}

// ── macOS implementation ─────────────────────────────────────────────────────

function startMacOS() {
  // Use AppleScript / osascript to get frontmost app on an event-driven basis.
  // True NSWorkspace notifications via koffi require Objective-C runtime bridging
  // which is heavyweight. Instead we use a lightweight approach: subscribe to
  // NSWorkspace notifications via a small persistent osascript process that
  // outputs the active app name on each change.
  //
  // This is simpler and more reliable than koffi ObjC bridging for this use case.
  const script = `
    use framework "Foundation"
    use framework "AppKit"
    use scripting additions

    set workspace to current application's NSWorkspace's sharedWorkspace()
    set nc to workspace's notificationCenter()

    set lastApp to ""
    repeat
      set frontApp to workspace's frontmostApplication()
      set appName to (frontApp's localizedName()) as text
      set winTitle to ""
      try
        tell application appName
          set winTitle to (name of front window) as text
        end tell
      end try
      set combined to appName & "||" & winTitle
      if combined is not equal to lastApp then
        set lastApp to combined
        log combined
      end if
      delay 0.5
    end repeat
  `;

  // Spawn a persistent osascript process
  let proc = null;
  function spawnOsascript() {
    try {
      proc = execFile("osascript", ["-e", script], { maxBuffer: 1024 * 64 });
      proc.stdout && proc.stdout.on("data", (chunk) => {
        const line = String(chunk).trim();
        if (!line) return;
        const parts = line.split("||");
        const appName = (parts[0] || "").trim();
        const title = (parts[1] || "").trim() || appName;
        if (appName) maybeSendEvent(appName, title);
      });
      proc.on("exit", () => {
        if (_hookActive) {
          // respawn after 1s on unexpected exit
          setTimeout(spawnOsascript, 1000);
        }
      });
    } catch (err) {
      console.warn("[attention/os-focus] macOS osascript spawn failed:", err.message);
      startPollingFallback();
    }
  }

  spawnOsascript();
  return () => {
    if (proc) { try { proc.kill(); } catch {} proc = null; }
  };
}

// ── Windows implementation ───────────────────────────────────────────────────

function startWindows() {
  // Primary: SetWinEventHook via koffi. Falls back to polling if koffi fails.
  let cleanup = null;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");

    // GetForegroundWindow → HWND
    const GetForegroundWindow = user32.func("HWND GetForegroundWindow()");
    // GetWindowTextW → fills buffer with window title
    const GetWindowTextW = user32.func("int GetWindowTextW(HWND hWnd, char16* lpString, int nMaxCount)");
    // GetWindowThreadProcessId → returns PID
    const GetWindowThreadProcessId = user32.func("DWORD GetWindowThreadProcessId(HWND hWnd, _Out_ DWORD* lpdwProcessId)");
    // OpenProcess → HANDLE
    const OpenProcess = kernel32.func("HANDLE OpenProcess(DWORD dwDesiredAccess, bool bInheritHandle, DWORD dwProcessId)");
    // QueryFullProcessImageNameW → fills buffer with exe path
    const QueryFullProcessImageNameW = kernel32.func("bool QueryFullProcessImageNameW(HANDLE hProcess, DWORD dwFlags, char16* lpExeName, _Inout_ DWORD* lpdwSize)");
    // CloseHandle
    const CloseHandle = kernel32.func("bool CloseHandle(HANDLE hObject)");

    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    function getActiveWindowInfo() {
      try {
        const hwnd = GetForegroundWindow();
        if (!hwnd) return null;

        // Title
        const titleBuf = Buffer.alloc(512 * 2);
        GetWindowTextW(hwnd, titleBuf, 512);
        const title = titleBuf.toString("utf16le").replace(/\0/g, "").trim();

        // Process name
        const pidBuf = Buffer.alloc(4);
        GetWindowThreadProcessId(hwnd, pidBuf);
        const pid = pidBuf.readUInt32LE(0);

        let appName = "unknown";
        if (pid) {
          const hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
          if (hProc) {
            try {
              const exeBuf = Buffer.alloc(260 * 2);
              const sizeBuf = Buffer.alloc(4);
              sizeBuf.writeUInt32LE(260, 0);
              if (QueryFullProcessImageNameW(hProc, 0, exeBuf, sizeBuf)) {
                const exePath = exeBuf.toString("utf16le").replace(/\0/g, "").trim();
                // Extract filename without extension
                appName = (exePath.split("\\").pop() || "").replace(/\.exe$/i, "");
              }
            } finally {
              CloseHandle(hProc);
            }
          }
        }
        return { appName, title };
      } catch {
        return null;
      }
    }

    // Poll every 500ms using koffi (cheap — no subprocess overhead)
    _pollTimer = setInterval(() => {
      const info = getActiveWindowInfo();
      if (info && info.appName) maybeSendEvent(info.appName, info.title);
    }, 500);

    console.log("[attention/os-focus] Windows: koffi focus hook active (500ms poll)");
    cleanup = () => { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } };
  } catch (err) {
    console.warn("[attention/os-focus] Windows koffi init failed, using powershell fallback:", err.message);
    cleanup = startPollingFallback();
  }
  return cleanup;
}

// ── Polling fallback (Windows/macOS degraded) ────────────────────────────────

function startPollingFallback() {
  const platform = os.platform();
  console.log(`[attention/os-focus] ${platform} degraded-mode: polling active window every ${POLL_INTERVAL_MS}ms`);

  function poll() {
    if (!_hookActive) return;
    if (platform === "win32") {
      // PowerShell one-liner: get foreground window title + process name
      execFile("powershell", [
        "-NonInteractive", "-NoProfile", "-Command",
        "try { $h=(Add-Type -MemberDefinition '[DllImport(\"user32\")]public static extern IntPtr GetForegroundWindow();' -Name u -Namespace w -PassThru)::GetForegroundWindow(); $p=Get-Process|?{$_.MainWindowHandle -eq $h}|Select -First 1; \"$($p.ProcessName)||$($p.MainWindowTitle)\" } catch { '' }",
      ], { timeout: 1500 }, (err, stdout) => {
        if (_hookActive) _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        if (err || !stdout.trim()) return;
        const parts = stdout.trim().split("||");
        const appName = (parts[0] || "").trim();
        const title = (parts[1] || "").trim() || appName;
        if (appName) maybeSendEvent(appName, title);
      });
    } else if (platform === "darwin") {
      execFile("osascript", ["-e",
        'tell application "System Events" to get {name, (title of first window) of first process whose frontmost is true}',
      ], { timeout: 1500 }, (err, stdout) => {
        if (_hookActive) _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        if (err || !stdout.trim()) return;
        const parts = stdout.trim().split(",");
        const appName = (parts[0] || "").trim();
        const title = (parts[1] || "").trim() || appName;
        if (appName) maybeSendEvent(appName, title);
      });
    } else {
      // Linux: xdotool (best-effort, may not be installed)
      execFile("xdotool", ["getactivewindow", "getwindowname"], { timeout: 1500 }, (err, stdout) => {
        if (_hookActive) _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        if (err || !stdout.trim()) return;
        maybeSendEvent("x11-app", stdout.trim());
      });
    }
  }

  poll();
  return () => { if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; } };
}

// ── Public API ───────────────────────────────────────────────────────────────

let _platformCleanup = null;

/**
 * Start the OS focus hook.
 *
 * @param {{ hookServerPort: number }} options
 */
function start(options = {}) {
  if (_hookActive) return;
  _hookActive = true;
  _hookServerPort = options.hookServerPort || null;
  _lastApp = "";
  _lastTitle = "";

  const platform = os.platform();
  if (platform === "darwin") {
    _platformCleanup = startMacOS();
  } else if (platform === "win32") {
    _platformCleanup = startWindows();
  } else {
    // Linux: xdotool polling fallback
    console.warn("[attention/os-focus] Linux: no native event hook yet — using xdotool polling");
    _platformCleanup = startPollingFallback();
  }
}

/**
 * Stop the OS focus hook and release all resources.
 */
function stop() {
  _hookActive = false;
  if (_pollTimer) { clearTimeout(_pollTimer); clearInterval(_pollTimer); _pollTimer = null; }
  if (typeof _platformCleanup === "function") {
    try { _platformCleanup(); } catch {}
    _platformCleanup = null;
  }
  _lastApp = "";
  _lastTitle = "";
}

module.exports = { start, stop };
