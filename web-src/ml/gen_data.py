# 공 판별기 학습 데이터 생성 (흑백 카메라 기준)
# 후보 원(cx, cy, r)을 중심으로 2.6r 정사각형을 16x16 칸으로 나눠 칸 평균 → JS(detector)와 똑같은 방식으로 잘라냄
# 양성: 딤플 골프공(조명 방향·포화·블러·잡음·크기·배경·티·그림자·후보 원 오차)
# 음성: 평평한 흰 원판, 타원, 직사각형·카드, 둥근 사각형, 띠·줄, D자, 고리, 반사광, 신발·불규칙 덩어리, 배경 결, 크게 어긋난 공
import numpy as np, sys

G = 16          # 출력 격자
SPAN = 1.3      # 중심에서 ±1.3r
rng = np.random.default_rng(int(sys.argv[2]) if len(sys.argv) > 2 else 1)

# ---- 딤플 텍스처: 구면 위 딤플 깊이를 위도·경도 지도로 미리 계산 ----
def make_dimple_map(n=332, rad=0.085, H=256, W=512, jitter=0.03, seed=0):
    r = np.random.default_rng(seed)
    i = np.arange(n) + 0.5
    y = 1 - 2 * i / n; rr = np.sqrt(1 - y * y); th = np.pi * (3 - np.sqrt(5)) * np.arange(n)
    P = np.stack([np.cos(th) * rr, y, np.sin(th) * rr], 1) + r.normal(0, jitter, (n, 3))
    P /= np.linalg.norm(P, axis=1, keepdims=True)
    lat = (np.arange(H) + 0.5) / H * np.pi - np.pi / 2
    lon = (np.arange(W) + 0.5) / W * 2 * np.pi - np.pi
    LA, LO = np.meshgrid(lat, lon, indexing='ij')
    N = np.stack([np.cos(LA) * np.cos(LO), np.sin(LA), np.cos(LA) * np.sin(LO)], -1).reshape(-1, 3)
    d = np.zeros(len(N))
    for k in range(0, n, 64):
        c = np.clip(N @ P[k:k + 64].T, -1, 1)
        ang = np.arccos(c)
        v = np.clip(1 - (ang / rad) ** 2, 0, None)
        d = np.maximum(d, v.max(1))
    return d.reshape(H, W)

MAPS = [make_dimple_map(n, rad, seed=s) for n, rad, s in [(332, 0.085, 1), (392, 0.078, 2), (300, 0.09, 3)]]

def rot_random():
    q = rng.normal(size=4); q /= np.linalg.norm(q)
    a, b, c, d = q
    return np.array([[a*a+b*b-c*c-d*d, 2*(b*c-a*d), 2*(b*d+a*c)], [2*(b*c+a*d), a*a-b*b+c*c-d*d, 2*(c*d-a*b)], [2*(b*d-a*c), 2*(c*d+a*b), a*a-b*b-c*c+d*d]])

# ---- 배경 ----
def background(S):
    t = rng.integers(0, 6)
    yy, xx = np.mgrid[0:S, 0:S].astype(float)
    if t == 0:   # 어두운 매트(결)
        base = rng.uniform(35, 95); f1, f2 = rng.uniform(0.4, 1.4, 2)
        img = base + rng.uniform(4, 14) * np.sin(xx * f1) * np.sin(yy * f2) + rng.normal(0, rng.uniform(2, 9), (S, S))
    elif t == 1: # 잔디
        img = rng.uniform(55, 120) + rng.normal(0, rng.uniform(8, 20), (S, S))
    elif t == 2: # 하늘·밝은 벽(그라디언트)
        a = rng.uniform(0, 2 * np.pi)
        img = rng.uniform(90, 190) + rng.uniform(-30, 30) * ((xx * np.cos(a) + yy * np.sin(a)) / S) + rng.normal(0, 3, (S, S))
    elif t == 3: # 밝은 회색 바닥
        img = rng.uniform(120, 180) + rng.normal(0, rng.uniform(3, 10), (S, S))
    elif t == 4: # 거의 검정
        img = rng.uniform(5, 40) + rng.normal(0, 3, (S, S))
    else:        # 반은 매트, 반은 밝은 면(경계 있는 배경)
        a = rng.uniform(0, 2 * np.pi); off = rng.uniform(-0.3, 0.3) * S
        m = (xx - S / 2) * np.cos(a) + (yy - S / 2) * np.sin(a) > off
        img = np.where(m, rng.uniform(40, 90), rng.uniform(110, 190)) + rng.normal(0, 5, (S, S))
    return img

def add_lines(img, S):
    # 방해 직선(매트 흰 줄 등)을 가끔 추가
    if rng.random() < 0.25:
        yy, xx = np.mgrid[0:S, 0:S].astype(float)
        a = rng.uniform(0, np.pi); c = rng.uniform(0.1, 0.9) * S; wdt = rng.uniform(1, 0.1 * S)
        d = np.abs((xx - S / 2) * np.cos(a) + (yy - S / 2) * np.sin(a) - (c - S / 2))
        img = np.where(d < wdt, rng.uniform(150, 255), img)
    return img

# ---- 공 그리기 (고해상도 → 카메라 해상도) ----
def draw_ball(img, cx, cy, R, ss=2):
    S = img.shape[0]
    M = MAPS[rng.integers(len(MAPS))]; Rot = rot_random()
    L = rng.normal(size=3); L[2] = -abs(L[2]) if rng.random() < 0.7 else abs(L[2]); L /= np.linalg.norm(L)  # 주로 카메라 쪽 조명
    amb = rng.uniform(40, 120); dif = rng.uniform(90, 200); gain = rng.choice([1.0, 1.0, rng.uniform(1.2, 2.6)])
    depth = rng.uniform(25, 70)
    x0, x1 = int(max(0, cx - R - 2)), int(min(S, cx + R + 3)); y0, y1 = int(max(0, cy - R - 2)), int(min(S, cy + R + 3))
    if x1 <= x0 or y1 <= y0: return img
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(float)
    acc = np.zeros(xs.shape); cov = np.zeros(xs.shape)
    for sy in range(ss):
        for sx in range(ss):
            dx = (xs + (sx + .5) / ss - cx) / R; dy = (ys + (sy + .5) / ss - cy) / R
            q = dx * dx + dy * dy; inside = q <= 1
            nz = -np.sqrt(np.clip(1 - q, 0, 1))
            N = np.stack([dx, dy, nz], -1)
            lam = np.clip(N @ (-L * np.array([1, 1, 1])) * -1, 0, None)  # n·(광원방향)
            lam = np.clip((N * L).sum(-1), 0, None)
            B = N @ Rot.T
            lat = np.arcsin(np.clip(B[..., 1], -1, 1)); lon = np.arctan2(B[..., 2], B[..., 0])
            hi = ((lat + np.pi / 2) / np.pi * M.shape[0]).astype(int).clip(0, M.shape[0] - 1)
            wi = ((lon + np.pi) / (2 * np.pi) * M.shape[1]).astype(int).clip(0, M.shape[1] - 1)
            v = (amb + dif * lam - depth * M[hi, wi] * (0.6 + 0.4 * lam)) * gain
            acc += np.where(inside, v, 0); cov += inside
    a = cov / (ss * ss)
    region = img[y0:y1, x0:x1]
    img[y0:y1, x0:x1] = np.where(cov > 0, np.clip(acc / np.maximum(cov, 1), 0, 255) * a + region * (1 - a), region)
    return img

def draw_shape(img, kind, cx, cy, R):
    S = img.shape[0]
    yy, xx = np.mgrid[0:S, 0:S].astype(float)
    v = rng.uniform(170, 255); a = rng.uniform(0, np.pi)
    u = (xx - cx) * np.cos(a) + (yy - cy) * np.sin(a); w = -(xx - cx) * np.sin(a) + (yy - cy) * np.cos(a)
    if kind == 'disk': m = u * u + w * w < R * R
    elif kind == 'ellipse': e = rng.uniform(1.15, 1.8); m = (u / (R * e)) ** 2 + (w / R) ** 2 < 1
    elif kind == 'rect': e = rng.uniform(1.0, 1.9); m = (np.abs(u) < R * e) & (np.abs(w) < R)
    elif kind == 'rrect': e = rng.uniform(1.0, 1.6); k = R * rng.uniform(0.2, 0.6); m = (np.maximum(np.abs(u) - (R * e - k), 0) ** 2 + np.maximum(np.abs(w) - (R - k), 0) ** 2) < k * k
    elif kind == 'stripe': m = np.abs(w) < R * rng.uniform(0.15, 0.6)
    elif kind == 'dshape': m = (u * u + w * w < R * R) & (u < R * rng.uniform(0.0, 0.6))
    elif kind == 'ring': m = (u * u + w * w < R * R) & (u * u + w * w > (R * rng.uniform(0.4, 0.8)) ** 2)
    elif kind == 'blob':  # 불규칙(신발 앞코·옷)
        ang = np.arctan2(w, u); rad = R * (1 + 0.25 * np.sin(3 * ang + rng.uniform(0, 6)) + 0.15 * np.sin(5 * ang + rng.uniform(0, 6)))
        m = np.sqrt(u * u + w * w) < rad
    elif kind == 'spec':  # 반사광(작고 아주 밝음)
        m = (u / (R * rng.uniform(0.3, 0.8))) ** 2 + (w / (R * rng.uniform(0.15, 0.4))) ** 2 < 1; v = 255
    elif kind == 'shaded_flat':  # 그라디언트만 있는 평면 원판(종이에 그림자)
        m = u * u + w * w < R * R; v = np.clip(rng.uniform(150, 230) + rng.uniform(-40, 40) * u / R, 0, 255)
    else: m = np.zeros_like(u, bool)
    tex = rng.normal(0, rng.uniform(1, 8), img.shape)
    img = np.where(m, np.clip(v + tex, 0, 255), img)
    return img

def crop(img, cx, cy, r):
    # JS와 동일: [cx-1.3r, cx+1.3r]를 16칸으로 나눠 칸 안 픽셀 평균
    S = img.shape[0]; out = np.zeros((G, G))
    x0 = cx - SPAN * r; step = 2 * SPAN * r / G
    for j in range(G):
        ya, yb = int(np.floor(cy - SPAN * r + j * step)), int(np.floor(cy - SPAN * r + (j + 1) * step))
        yb = max(yb, ya + 1)
        for i in range(G):
            xa, xb = int(np.floor(x0 + i * step)), int(np.floor(x0 + (i + 1) * step)); xb = max(xb, xa + 1)
            cell = img[max(0, ya):min(S, yb), max(0, xa):min(S, xb)]
            out[j, i] = cell.mean() if cell.size else 0
    return out

def blur(img):
    if rng.random() < 0.3:
        k = rng.integers(2, 6); a = rng.uniform(0, np.pi)
        acc = np.zeros_like(img)
        for t in range(k):
            dx, dy = int(round(np.cos(a) * t)), int(round(np.sin(a) * t))
            acc += np.roll(np.roll(img, dy, 0), dx, 1)
        img = acc / k
    return img

def sample(pos):
    R = rng.uniform(7, 40)
    S = int(np.ceil(R * 3.4)) + 8
    img = background(S)
    cx = cy = S / 2 + rng.uniform(-0.5, 0.5)
    if pos:
        if rng.random() < 0.35:  # 티(흰/주황/검정 줄) 또는 그림자
            yy, xx = np.mgrid[0:S, 0:S].astype(float)
            tw = R * rng.uniform(0.15, 0.35)
            img = np.where((np.abs(xx - cx) < tw) & (yy > cy + R * 0.9) & (yy < cy + R * rng.uniform(1.6, 2.5)), rng.choice([rng.uniform(170, 240), rng.uniform(20, 60)]), img)
        if rng.random() < 0.3:
            yy, xx = np.mgrid[0:S, 0:S].astype(float)
            sh = ((xx - cx - R * 0.3) / (R * 1.1)) ** 2 + ((yy - cy - R * 0.85) / (R * 0.35)) ** 2 < 1
            img = np.where(sh, img * rng.uniform(0.4, 0.8), img)
        img = draw_ball(img, cx, cy, R)
        # 후보 원 추정 오차(중심 ±10%, 반지름 ±12%)
        ex, ey, er = rng.normal(0, 0.06 * R), rng.normal(0, 0.06 * R), R * np.clip(rng.normal(1, 0.07), 0.85, 1.15)
    else:
        kind = rng.choice(['disk', 'disk', 'ellipse', 'rect', 'rect', 'rrect', 'stripe', 'dshape', 'ring', 'blob', 'blob', 'spec', 'shaded_flat', 'none', 'ball_off'])
        if kind == 'ball_off':  # 공을 엉뚱한 원으로 잡은 경우(중심 크게 어긋남/크기 2배)
            img = draw_ball(img, cx, cy, R)
            if rng.random() < 0.5: ex, ey, er = rng.choice([-1, 1]) * R * rng.uniform(0.6, 1.0), rng.normal(0, 0.3 * R), R
            else: ex, ey, er = 0, 0, R * rng.choice([rng.uniform(0.35, 0.55), rng.uniform(1.9, 2.5)])
        else:
            img = draw_shape(img, kind, cx, cy, R)
            ex, ey, er = rng.normal(0, 0.05 * R), rng.normal(0, 0.05 * R), R * np.clip(rng.normal(1, 0.08), 0.8, 1.2)
    img = add_lines(img, S)
    img = blur(img)
    img = np.clip(img + rng.normal(0, rng.uniform(0.5, 5), img.shape), 0, 255)
    img = np.round(img)  # 8비트
    return crop(img, cx + ex, cy + ey, er)

if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    X = np.zeros((2 * n, G * G), np.float32); y = np.zeros(2 * n, np.float32)
    for k in range(n):
        X[2 * k] = sample(True).ravel(); y[2 * k] = 1
        X[2 * k + 1] = sample(False).ravel(); y[2 * k + 1] = 0
    out = sys.argv[3] if len(sys.argv) > 3 else 'data.npz'
    np.savez_compressed(out, X=X, y=y)
    print('saved', out, X.shape)
