
# ---- analytic distances between copper items -------------------------------------------------
def _pt_seg(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1; ll = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / ll)) if ll else 0.0
    return math.hypot(px - x1 - t * dx, py - y1 - t * dy)
def _cross(ax, ay, bx, by, cx, cy): return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
def _seg_seg(a, b):
    (x1, y1, x2, y2), (x3, y3, x4, y4) = a, b
    d1, d2 = _cross(x1, y1, x2, y2, x3, y3), _cross(x1, y1, x2, y2, x4, y4)
    d3, d4 = _cross(x3, y3, x4, y4, x1, y1), _cross(x3, y3, x4, y4, x2, y2)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 != 0 and d2 != 0 and d3 != 0 and d4 != 0: return 0.0
    return min(_pt_seg(x1, y1, x3, y3, x4, y4), _pt_seg(x2, y2, x3, y3, x4, y4), _pt_seg(x3, y3, x1, y1, x2, y2), _pt_seg(x4, y4, x1, y1, x2, y2))
def _rect_pt(cx, cy, hw, hh, px, py): return math.hypot(max(0.0, abs(px - cx) - hw), max(0.0, abs(py - cy) - hh))
def _rect_edges(cx, cy, hw, hh):
    c = [(cx - hw, cy - hh), (cx + hw, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh)]
    return [(c[i][0], c[i][1], c[(i + 1) % 4][0], c[(i + 1) % 4][1]) for i in range(4)]
def distance(a, b):
    ka, kb = a[0], b[0]
    if ka > kb: a, b, ka, kb = b, a, kb, ka                    # order: circle < rect < seg
    order_ = {"circle": 0, "rect": 1, "seg": 2}
    if order_[ka] > order_[kb]: a, b, ka, kb = b, a, kb, ka
    if ka == "circle" and kb == "circle": return math.hypot(a[1] - b[1], a[2] - b[2]) - a[3] - b[3]
    if ka == "circle" and kb == "rect": return _rect_pt(b[1], b[2], b[3], b[4], a[1], a[2]) - a[3]
    if ka == "circle" and kb == "seg": return _pt_seg(a[1], a[2], b[1], b[2], b[3], b[4]) - a[3] - b[5]
    if ka == "rect" and kb == "rect": return math.hypot(max(0.0, abs(a[1] - b[1]) - a[3] - b[3]), max(0.0, abs(a[2] - b[2]) - a[4] - b[4]))
    if ka == "rect" and kb == "seg":
        for x, y in ((b[1], b[2]), (b[3], b[4])):
            if abs(x - a[1]) <= a[3] and abs(y - a[2]) <= a[4]: return -b[5]
        return min(_seg_seg(e, b[1:5]) for e in _rect_edges(a[1], a[2], a[3], a[4])) - b[5]
    return _seg_seg(a[1:5], b[1:5]) - a[5] - b[5]
def bbox(g):
    if g[0] == "seg": return (min(g[1], g[3]) - g[5], min(g[2], g[4]) - g[5], max(g[1], g[3]) + g[5], max(g[2], g[4]) + g[5])
    if g[0] == "circle": return (g[1] - g[3], g[2] - g[3], g[1] + g[3], g[2] + g[3])
    return (g[1] - g[3], g[2] - g[4], g[1] + g[3], g[2] + g[4])
