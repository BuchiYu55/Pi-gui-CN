# winctl.ps1 - Win32 helpers for verify-trayclose.mjs (ASCII only: PS 5.1 reads
# BOM-less non-ASCII .ps1 as GBK and garbles text - see AGENTS.md pitfall).
# Commands: close <hwnd> | visible <hwnd> | dialogs <pid> | buttons <hwnd> | clickbtn <hwnd>
param([string]$cmd, [long]$hwnd = 0, [int]$procid = 0)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinCtl {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static List<string> DialogsOf(uint pid) {
    var res = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var cn = new StringBuilder(256); GetClassName(h, cn, 256);
        if (cn.ToString() == "#32770") {
          var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
          res.Add(h.ToInt64().ToString() + "|" + sb.ToString());
        }
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static List<string> ChildButtons(long h) {
    var res = new List<string>();
    EnumChildWindows(new IntPtr(h), delegate(IntPtr c, IntPtr l) {
      var cn = new StringBuilder(256); GetClassName(c, cn, 256);
      if (cn.ToString() == "Button") {
        var sb = new StringBuilder(512); GetWindowText(c, sb, 512);
        res.Add(c.ToInt64().ToString() + "|" + sb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static void WmClose(long h) { SendMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  public static void ClickButton(long h) { SendMessage(new IntPtr(h), 0x00F5, IntPtr.Zero, IntPtr.Zero); }
  public static int IsVisible(long h) { return IsWindowVisible(new IntPtr(h)) ? 1 : 0; }
}
"@
switch ($cmd) {
  "close"    { [WinCtl]::WmClose($hwnd); Write-Output "ok" }
  "visible"  { Write-Output ([string][WinCtl]::IsVisible($hwnd)) }
  "dialogs"  { $r = [WinCtl]::DialogsOf([uint32]$procid); if ($r.Count -eq 0) { Write-Output "" } else { $r | ForEach-Object { Write-Output $_ } } }
  "buttons"  { $r = [WinCtl]::ChildButtons($hwnd); if ($r.Count -eq 0) { Write-Output "" } else { $r | ForEach-Object { Write-Output $_ } } }
  "clickbtn" { [WinCtl]::ClickButton($hwnd); Write-Output "ok" }
  default    { Write-Output "unknown-cmd" }
}
