$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeIcon {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
"@

$resources = Join-Path $PSScriptRoot "..\resources"
New-Item -ItemType Directory -Force -Path $resources | Out-Null
$pngPath = Join-Path $resources "icon.png"
$icoPath = Join-Path $resources "icon.ico"

$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$bounds = New-Object System.Drawing.Rectangle 10, 10, 236, 236
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 50
$path.AddArc($bounds.X, $bounds.Y, $radius, $radius, 180, 90)
$path.AddArc($bounds.Right - $radius, $bounds.Y, $radius, $radius, 270, 90)
$path.AddArc($bounds.Right - $radius, $bounds.Bottom - $radius, $radius, $radius, 0, 90)
$path.AddArc($bounds.X, $bounds.Bottom - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()

$start = [System.Drawing.Color]::FromArgb(255, 150, 247, 217)
$end = [System.Drawing.Color]::FromArgb(255, 48, 194, 157)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bounds, $start, $end, 45
$graphics.FillPath($brush, $path)

$inner = New-Object System.Drawing.Rectangle 31, 31, 194, 194
$innerPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$innerRadius = 36
$innerPath.AddArc($inner.X, $inner.Y, $innerRadius, $innerRadius, 180, 90)
$innerPath.AddArc($inner.Right - $innerRadius, $inner.Y, $innerRadius, $innerRadius, 270, 90)
$innerPath.AddArc($inner.Right - $innerRadius, $inner.Bottom - $innerRadius, $innerRadius, $innerRadius, 0, 90)
$innerPath.AddArc($inner.X, $inner.Bottom - $innerRadius, $innerRadius, $innerRadius, 90, 90)
$innerPath.CloseFigure()
$graphics.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(34, 5, 34, 27))), $innerPath)

$font = New-Object System.Drawing.Font "Segoe UI", 76, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 230, 255, 247))
$graphics.DrawString("AT", $font, $textBrush, (New-Object System.Drawing.RectangleF 29, 25, 198, 202), $format)

$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$handle = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($handle)
$stream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$icon.Save($stream)
$stream.Dispose()
$icon.Dispose()
[NativeIcon]::DestroyIcon($handle) | Out-Null
$textBrush.Dispose()
$format.Dispose()
$font.Dispose()
$innerPath.Dispose()
$brush.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated $pngPath and $icoPath"
