// ============================================================================
//  Screen capture, for Jarvis to look at ("what am I looking at?").
//
//    -> {"cmd":"capture","id":7,"target":"window"|"screen","maxSide":1568}
//    <- {"type":"capture","id":7,"ok":true,"images":[{"data":"<jpeg b64>","width","height"}],
//        "title","process","rect":[x,y,w,h]}
//
//  window = the window in front (what you are looking at); the desktop, the
//  taskbar or this panel's own window fall back to the screen it is on.
//  screen = the whole monitor the front window is on (the main one when the
//  panel is in front).
//
//  GDI BitBlt into a 32-bit DIB, then Windows' own JPEG encoder (WinRT) with
//  its scaler: no packages. A very wide shot (the 32:9 main monitor) is cut
//  into side-by-side tiles first, so each is near 16:9 and text stays big
//  enough to read once scaled to maxSide. The process is per-monitor DPI
//  aware (Main), so the rectangles are real pixels.
//
//  Exclusive-fullscreen games can come back black (they bypass the desktop
//  compositor); borderless and windowed are fine.
// ============================================================================
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Y70Voice;

internal static partial class Program
{
    static void CaptureScreen(int id, string target, int maxSide)
    {
        try
        {
            maxSide = Math.Clamp(maxSide, 512, 2560);
            var fg = GetForegroundWindow();
            string title = "", proc = "";
            if (fg != IntPtr.Zero)
            {
                var sb = new StringBuilder(256);
                GetWindowTextW(fg, sb, sb.Capacity);
                title = sb.ToString();
                GetWindowThreadProcessId(fg, out var pid);
                try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            }
            var cls = new StringBuilder(128);
            if (fg != IntPtr.Zero) GetClassNameW(fg, cls, cls.Capacity);
            var c = cls.ToString();
            var notAWindow = fg == IntPtr.Zero || IsIconic(fg) || c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" ||
                proc.Equals("Y70 Dashboard", StringComparison.OrdinalIgnoreCase) || proc.Equals("electron", StringComparison.OrdinalIgnoreCase);

            // The monitor: the front window's, or the main one for the panel.
            var mon = notAWindow ? MonitorFromPoint(new POINT { X = 0, Y = 0 }, 1) : MonitorFromWindow(fg, 2);
            var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            GetMonitorInfo(mon, ref mi);
            var r = mi.rcMonitor;
            if (target != "screen" && !notAWindow)
            {
                // The visible frame (DWM), not the invisible resize border.
                if (DwmGetWindowAttribute(fg, 9, out RECT wr, Marshal.SizeOf<RECT>()) != 0) GetWindowRect(fg, out wr);
                // Kept to the monitor it is on.
                var x0 = Math.Max(wr.Left, r.Left); var y0 = Math.Max(wr.Top, r.Top);
                var x1 = Math.Min(wr.Right, r.Right); var y1 = Math.Min(wr.Bottom, r.Bottom);
                if (x1 - x0 >= 200 && y1 - y0 >= 150) r = new RECT { Left = x0, Top = y0, Right = x1, Bottom = y1 };
            }
            else if (notAWindow) { title = ""; proc = ""; }

            var w = r.Right - r.Left; var h = r.Bottom - r.Top;
            var pixels = Grab(r.Left, r.Top, w, h);
            // Wide shots in tiles near 16:9.
            var tiles = Math.Max(1, (int)Math.Round(w / (h * 16.0 / 9.0)));
            if (w / (double)h < 2.2) tiles = 1;
            var images = new List<object>();
            var tileW = w / tiles;
            for (var i = 0; i < tiles; i++)
            {
                var tw = i == tiles - 1 ? w - tileW * i : tileW;
                var (jpeg, ow, oh) = Encode(pixels, w, h, tileW * i, tw, maxSide);
                images.Add(new { data = Convert.ToBase64String(jpeg), width = ow, height = oh });
            }
            Emit(new { type = "capture", id, ok = true, images, title, process = proc, target = notAWindow ? "screen" : target, rect = new[] { r.Left, r.Top, w, h } });
        }
        catch (Exception e)
        {
            Emit(new { type = "capture", id, ok = false, error = e.Message });
        }
    }

    // The screen's pixels (BGRA, top-down) for one rectangle.
    static byte[] Grab(int x, int y, int w, int h)
    {
        var screen = GetDC(IntPtr.Zero);
        var mem = CreateCompatibleDC(screen);
        var bmp = CreateCompatibleBitmap(screen, w, h);
        var old = SelectObject(mem, bmp);
        try
        {
            // CAPTUREBLT takes in layered windows (tooltips, some overlays).
            BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020 | 0x40000000);
            var bi = new BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32, biCompression = 0 };
            var buf = new byte[w * h * 4];
            SelectObject(mem, old);
            if (GetDIBits(mem, bmp, 0, (uint)h, buf, ref bi, 0) == 0) throw new Exception("GetDIBits failed");
            return buf;
        }
        finally
        {
            DeleteObject(bmp); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
        }
    }

    // A column range of the pixels, scaled so its longest side is maxSide at
    // most, as JPEG.
    static (byte[] jpeg, int w, int h) Encode(byte[] px, int w, int h, int x0, int tw, int maxSide)
    {
        var tile = new byte[tw * h * 4];
        for (var row = 0; row < h; row++) System.Buffer.BlockCopy(px, (row * w + x0) * 4, tile, row * tw * 4, tw * 4);
        var scale = Math.Min(1.0, maxSide / (double)Math.Max(tw, h));
        var ow = Math.Max(1, (int)Math.Round(tw * scale)); var oh = Math.Max(1, (int)Math.Round(h * scale));
        return Task.Run(async () =>
        {
            using var sb = SoftwareBitmap.CreateCopyFromBuffer(tile.AsBuffer(), BitmapPixelFormat.Bgra8, tw, h, BitmapAlphaMode.Ignore);
            using var ms = new InMemoryRandomAccessStream();
            var props = new BitmapPropertySet { { "ImageQuality", new BitmapTypedValue(0.82, Windows.Foundation.PropertyType.Single) } };
            var enc = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, ms, props);
            enc.SetSoftwareBitmap(sb);
            enc.BitmapTransform.ScaledWidth = (uint)ow;
            enc.BitmapTransform.ScaledHeight = (uint)oh;
            enc.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
            await enc.FlushAsync();
            var bytes = new byte[ms.Size];
            ms.Seek(0);
            using var reader = new DataReader(ms.GetInputStreamAt(0));
            await reader.LoadAsync((uint)ms.Size);
            reader.ReadBytes(bytes);
            return (bytes, ow, oh);
        }).GetAwaiter().GetResult();
    }

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER
    {
        public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bi, uint usage);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
}
