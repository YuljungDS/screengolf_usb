# 실제 카메라 프레임에서 학습 데이터 만들기
#  양성: 실제 공 원(중심·반지름 흔들기, 밝기·대비·잡음·흐림 변형)
#  음성: 같은 장면의 원 검출 후보(박스 모서리·천·망·LED 등) + 무작위 원 + 공에서 많이 어긋난 원
# 사용: python3 mine_real.py <프레임들(쉼표)> <출력.npz> [양성수] [음성수]
import numpy as np, json, sys
rng = np.random.default_rng(7)
G, SPAN, W, H = 16, 1.3, 640, 360
TRUTH = {'box': (431, 223, 48), 'box_clean': (431, 223, 48), 'led': (421, 264, 40), 'noball': None}

def crop(img, cx, cy, r):  # JS BallNet.crop과 동일
    out = np.zeros((G, G)); x0 = cx - SPAN * r; y0 = cy - SPAN * r; step = 2 * SPAN * r / G
    h, w = img.shape
    for j in range(G):
        ya = int(np.floor(y0 + j * step)); yb = max(int(np.floor(y0 + (j + 1) * step)), ya + 1)
        for i in range(G):
            xa = int(np.floor(x0 + i * step)); xb = max(int(np.floor(x0 + (i + 1) * step)), xa + 1)
            c = img[max(0, ya):min(h, yb), max(0, xa):min(w, xb)]
            out[j, i] = c.mean() if c.size else 0
    return out.ravel()

def photometric(img):
    g = img.astype(float)
    a = rng.uniform(0.7, 1.25); b = rng.uniform(-35, 35)
    g = g * a + b
    if rng.random() < 0.5:  # 비선형(감마)
        g = 255 * np.clip(g / 255, 0, 1) ** rng.uniform(0.7, 1.4)
    if rng.random() < 0.4:  # 흐림
        k = rng.integers(1, 3); p = np.pad(g, k, mode='edge'); s = np.zeros_like(g)
        for dy in range(-k, k + 1):
            for dx in range(-k, k + 1): s += p[k + dy:k + dy + g.shape[0], k + dx:k + dx + g.shape[1]]
        g = s / (2 * k + 1) ** 2
    g += rng.normal(0, rng.uniform(0, 6), g.shape)
    return np.clip(g, 0, 255)

names = sys.argv[1].split(','); outp = sys.argv[2]
NP = int(sys.argv[3]) if len(sys.argv) > 3 else 1500; NN = int(sys.argv[4]) if len(sys.argv) > 4 else 4000
cands = json.load(open('real_cands.json'))
imgs = {n: np.fromfile(f'../real/{n}.raw', np.uint8).reshape(H, W) for n in names}
X, y = [], []
withBall = [n for n in names if TRUTH[n]]
for k in range(NP):
    n = withBall[k % len(withBall)]; cx, cy, r = TRUTH[n]
    # 변형은 작은 영역만(속도)
    rr = r * rng.uniform(0.9, 1.12); x = cx + rng.normal(0, 0.06 * r); yv = cy + rng.normal(0, 0.06 * r)
    m = int(SPAN * rr * 1.2) + 4; x0, y0 = int(x) - m, int(yv) - m
    sub = imgs[n][max(0, y0):y0 + 2 * m, max(0, x0):x0 + 2 * m]
    sub = photometric(sub)
    X.append(crop(sub, x - max(0, x0), yv - max(0, y0), rr)); y.append(1)
for k in range(NN):
    n = names[k % len(names)]; img = imgs[n]; t = TRUTH[n]
    mode = rng.random()
    if mode < 0.55 and cands[n]:
        cx, cy, r = cands[n][rng.integers(len(cands[n]))]
        cx += rng.normal(0, 0.05 * r); cy += rng.normal(0, 0.05 * r); r *= rng.uniform(0.9, 1.1)
    elif mode < 0.8 or not t:
        r = rng.uniform(10, 90); cx = rng.uniform(r, W - r); cy = rng.uniform(r, H - r)
    else:  # 공과 많이 어긋난 원(일부만 걸침·너무 크거나 작음)
        bx, by, br = t
        if rng.random() < 0.5: a = rng.uniform(0, 2 * np.pi); d = rng.uniform(0.45, 1.6) * br; cx, cy, r = bx + d * np.cos(a), by + d * np.sin(a), br * rng.uniform(0.7, 1.3)
        else: cx, cy, r = bx + rng.normal(0, 0.1 * br), by + rng.normal(0, 0.1 * br), br * (rng.uniform(0.35, 0.6) if rng.random() < 0.5 else rng.uniform(1.6, 2.4))
    if t and abs(np.hypot(cx - t[0], cy - t[1])) < 0.3 * t[2] and 0.75 < r / t[2] < 1.33: continue  # 사실상 공이면 음성에서 제외
    m = int(SPAN * r * 1.2) + 4; x0, y0 = int(cx) - m, int(cy) - m
    sub = photometric(img[max(0, y0):y0 + 2 * m, max(0, x0):x0 + 2 * m])
    X.append(crop(sub, cx - max(0, x0), cy - max(0, y0), r)); y.append(0)
X = np.array(X, np.float32); y = np.array(y, np.float32)
np.savez_compressed(outp, X=X, y=y); print(outp, X.shape, 'pos', int(y.sum()))
