/**
 * A board being built in the real KiCad on a bot's desktop. The lab's placer and router run on the
 * bot's own computer as well and report every step; a plugin inside KiCad carries each step out on
 * the open board: parts move from beside the board onto it, tracks appear net by net, and the
 * ratsnest shrinks. Nothing here is drawn by Reality.
 */

/** Where the running build writes its steps, and where the plugin reads them. */
export const LIVE_EVENTS = '/home/gem/.reality-live/events.jsonl';

export const LIVE_PLUGIN = String.raw`# Reality: carries out the steps of a running board build on the board open in this window.
import json, os, threading, time, traceback
import pcbnew, wx

PATH = "/home/gem/.reality-live/events.jsonl"
LOG = "/tmp/reality_live.log"
rules = {"via": 0.6, "drill": 0.3}

def log(text):
    with open(LOG, "a") as f: f.write(text + "\n")

def at(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))

def set_outline(board, w, h):
    for d in list(board.GetDrawings()):
        if d.GetLayer() == pcbnew.Edge_Cuts: board.Remove(d)
    for x1, y1, x2, y2 in ((0, 0, w, 0), (w, 0, w, h), (w, h, 0, h), (0, h, 0, 0)):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(at(x1, y1)); s.SetEnd(at(x2, y2))
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(pcbnew.FromMM(0.1))
        board.Add(s)

def add_copper(board, e):
    net = board.FindNet(e["net"])
    for L, x1, y1, x2, y2, w in e.get("tracks", []):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(at(x1, y1)); t.SetEnd(at(x2, y2)); t.SetWidth(pcbnew.FromMM(w))
        t.SetLayer(pcbnew.F_Cu if L == 0 else pcbnew.B_Cu)
        t.SetNet(net)
        board.Add(t)
    for x, y in e.get("vias", []):
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(at(x, y)); v.SetWidth(pcbnew.FromMM(rules["via"])); v.SetDrill(pcbnew.FromMM(rules["drill"]))
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetNet(net)
        board.Add(v)

def remove_mark(board):
    for d in list(board.GetDrawings()):
        if d.GetLayer() == pcbnew.Cmts_User: board.Remove(d)

def add_mark(board, x):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(at(x, 0)); s.SetEnd(at(x + 0.1, 0))
    s.SetLayer(pcbnew.Cmts_User); s.SetWidth(pcbnew.FromMM(0.05))
    board.Add(s)

def pour(board, pours):
    if not pours: return
    box = board.GetBoardEdgesBoundingBox()
    x0, y0, x1, y1 = [pcbnew.ToMM(v) for v in (box.GetLeft(), box.GetTop(), box.GetRight(), box.GetBottom())]
    for p in pours:
        ax, ay, bx, by = p.get("rect") or (x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5)
        z = pcbnew.ZONE(board)
        z.SetNet(board.FindNet(p["net"]))
        z.SetLayer(pcbnew.F_Cu if p["layer"] == "F.Cu" else pcbnew.B_Cu)
        z.SetAssignedPriority(int(p.get("priority", 0)))
        z.SetLocalClearance(pcbnew.FromMM(0.25))
        z.SetMinThickness(pcbnew.FromMM(0.2))
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
        z.SetThermalReliefGap(pcbnew.FromMM(0.3))
        z.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.4))
        o = z.Outline()
        o.NewOutline()
        for x, y in ((ax, ay), (bx, ay), (bx, by), (ax, by)):
            o.Append(pcbnew.FromMM(x), pcbnew.FromMM(y))
        board.Add(z)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())

def chrome(show):
    # Menus and toolbars out of the way while it builds: just the board. They come back afterwards.
    import wx.aui
    for frame in wx.GetTopLevelWindows():
        if "PCB Editor" not in frame.GetTitle() and "3D Viewer" not in frame.GetTitle(): continue
        if frame.GetMenuBar(): frame.GetMenuBar().Show(show)
        manager = wx.aui.AuiManager.GetManager(frame)
        if manager:
            for pane in manager.GetAllPanes():
                if pane.IsToolbar(): pane.Show(show)
            manager.Update()
        frame.Layout()

def raytrace():
    # KiCad's own raytracer for the finished picture: the same button a person would press.
    import wx.aui
    for frame in wx.GetTopLevelWindows():
        if "3D Viewer" not in frame.GetTitle(): continue
        for bar in frame.GetChildren():
            if not isinstance(bar, wx.aui.AuiToolBar): continue
            for i in range(bar.GetToolCount()):
                tool = bar.FindToolByIndex(i)
                if "aytrac" in tool.GetShortHelp():
                    log("raytrace button %s" % tool.GetShortHelp())
                    event = wx.CommandEvent(wx.wxEVT_COMMAND_TOOL_CLICKED, tool.GetId())
                    event.SetEventObject(bar)
                    event.SetInt(1)
                    bar.GetEventHandler().ProcessEvent(event)
                    return True
    log("no raytrace button found")
    return False

def apply(lines):
    try:
        board = pcbnew.GetBoard()
        if board is None: return
        for line in lines:
            e = json.loads(line)
            k = e["kind"]
            if k == "chrome": chrome(e["show"])
            elif k == "raytrace": raytrace()
            elif k == "rules": rules.update(via=e["via"], drill=e["drill"])
            elif k == "board": set_outline(board, e["w"], e["h"])
            elif k == "parts":
                for ref, x, y, rot in e["parts"]:
                    fp = board.FindFootprintByReference(ref)
                    if fp is not None:
                        fp.SetPosition(at(x, y)); fp.SetOrientationDegrees(rot)
            elif k == "placed":
                # With every part on the board, "fit" can come closer.
                remove_mark(board)
                add_mark(board, e["w"] * 2.1)
            elif k == "clear":
                for t in list(board.GetTracks()): board.Remove(t)
            elif k == "unroute":
                net = board.FindNet(e["net"])
                for t in list(board.GetTracks()):
                    if t.GetNetCode() == net.GetNetCode(): board.Remove(t)
            elif k == "route": add_copper(board, e)
            elif k == "pours": pour(board, e["pours"])
            elif k == "done":
                remove_mark(board)
                pcbnew.SaveBoard(board.GetFileName(), board)
                with open(PATH + ".saved", "w") as f: f.write("saved")
        board.BuildConnectivity()
        pcbnew.Refresh()
        pcbnew.UpdateUserInterface()
    except Exception:
        log(traceback.format_exc())

def follow():
    seen = 0
    while True:
        time.sleep(0.15)
        try:
            size = os.path.getsize(PATH) if os.path.exists(PATH) else 0
            if size < seen: seen = 0
            if size == seen: continue
            with open(PATH) as f:
                f.seek(seen)
                text = f.read()
            done = text.rfind("\n") + 1
            if not done: continue
            seen += len(text[:done].encode())
            wx.CallAfter(apply, text[:done].splitlines())
        except Exception:
            log(traceback.format_exc())

threading.Thread(target=follow, daemon=True).start()
log("reality live ready")
`;

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

/** Light, like a printed layout: copper in copper, the back in blue, the ratsnest thin and pale. */
export const LIVE_THEME = JSON.stringify({
  board: {
    background: rgb(255, 255, 255),
    grid: rgb(225, 225, 225),
    grid_axes: rgb(225, 225, 225),
    cursor: rgb(120, 120, 120),
    anchor: rgb(180, 180, 180),
    aux_items: rgb(120, 120, 120),
    ratsnest: rgb(120, 190, 225),
    edge_cuts: rgb(70, 70, 70),
    copper: { f: rgb(190, 78, 40), b: rgb(60, 130, 215) },
    pad_plated_hole: rgb(60, 70, 75),
    pad_through_hole: rgb(190, 78, 40),
    plated_hole: rgb(60, 70, 75),
    via_through: rgb(215, 150, 50),
    via_hole: rgb(60, 70, 75),
    f_silks: rgb(70, 70, 70),
    b_silks: rgb(120, 120, 120),
    f_fab: rgb(70, 70, 70),
    b_fab: rgb(120, 120, 120),
    f_crtyd: rgb(170, 170, 170),
    b_crtyd: rgb(190, 190, 190),
    footprint_text_invisible: rgb(190, 190, 190),
    no_connect: rgb(120, 120, 120),
    // No page around the board.
    worksheet: rgb(255, 255, 255),
    page_limits: rgb(255, 255, 255),
    // The mark that keeps the fitted view in the half of the window that shows.
    cmts_user: rgb(255, 255, 255),
  },
  '3d_viewer': {
    background_top: rgb(255, 255, 255),
    background_bottom: rgb(235, 238, 240),
    board: rgb(60, 80, 40),
    copper: rgb(200, 170, 80),
    silkscreen_top: rgb(245, 245, 245),
    silkscreen_bottom: rgb(245, 245, 245),
    soldermask_top: rgb(16, 92, 56),
    soldermask_bottom: rgb(16, 92, 56),
    solderpaste: rgb(170, 170, 170),
  },
  meta: { name: 'Reality', version: 5 },
});

/** Makes KiCad use that theme, whatever its settings file already says. */
export const USE_LIVE_THEME = String.raw`
import json, os
d = os.path.expanduser("~/.config/kicad/8.0")
os.makedirs(d + "/colors", exist_ok=True)
p = d + "/pcbnew.json"
try: s = json.load(open(p))
except Exception: s = {"meta": {"filename": "pcbnew.json", "version": 5}}
s.setdefault("appearance", {})["color_theme"] = "reality"
s.setdefault("aui", {})["show_layer_manager"] = False
json.dump(s, open(p, "w"))
p = d + "/3d_viewer.json"
try: s = json.load(open(p))
except Exception: s = {"meta": {"filename": "3d_viewer.json", "version": 5}}
s.setdefault("appearance", {})["color_theme"] = "reality"
s.setdefault("aui", {})["show_layer_manager"] = False
json.dump(s, open(p, "w"))
`;

/**
 * The board before anything has happened: outline and nets as designed, no copper, and every part
 * lying beside the board in rows, the way a layout starts.
 */
export function partsBeside(board: string): string {
  const lines = board.split('\n').filter((l) => !/^\s*\((segment|via) /.test(l));
  let right = 0;
  for (const l of lines) {
    const m = /^\s*\(gr_line \(start \S+ \S+\) \(end (\S+) \S+\)/.exec(l);
    if (m) right = Math.max(right, Number(m[1]));
  }
  const left = right + 6;
  const end = left + Math.max(right * 0.6, 30);
  let x = left;
  let y = 0;
  let row = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*\(footprint \S+ \(layer "F\.Cu"\) \(at )\S+ \S+((?: \S+)?\))$/.exec(
      lines[i] ?? '',
    );
    if (!m) continue;
    // The courtyard, a few lines on, says how much room the part takes.
    const size = lines
      .slice(i, i + 8)
      .map((l) => /\(fp_rect \(start (-?[\d.]+) (-?[\d.]+)\)/.exec(l))
      .find(Boolean);
    const hw = Math.abs(Number(size?.[1] ?? 2));
    const hh = Math.abs(Number(size?.[2] ?? 2));
    if (x > left && x + 2 * hw > end) {
      x = left;
      y += row + 3;
      row = 0;
    }
    lines[i] = `${m[1]}${(x + hw).toFixed(3)} ${(y + hh).toFixed(3)}${m[2]}`;
    x += 2 * hw + 3;
    row = Math.max(row, 2 * hh);
  }
  // KiCad will not shrink its window to half a screen, so the 3D viewer lies over its right part.
  // A mark far to the right makes "fit" leave everything in the half that shows.
  const close = lines.lastIndexOf(')');
  lines.splice(
    close,
    0,
    `  (gr_line (start ${(end * 1.9).toFixed(1)} 0) (end ${(end * 1.9 + 0.1).toFixed(1)} 0) (stroke (width 0.05) (type default)) (layer "Cmts.User"))`,
  );
  return lines.join('\n');
}
