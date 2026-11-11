# 공 판별 MLP 학습 (numpy) → JS 가중치 내보내기
import numpy as np, json, sys
rng = np.random.default_rng(0)
G = 16

def feats(X):
    X = X / 255.0
    m = X.mean(1, keepdims=True); s = X.std(1, keepdims=True)
    z = (X - m) / (s + 0.03)
    sat = (X > 0.97).mean(1, keepdims=True)
    return np.concatenate([z, m, s * 4, sat], 1).astype(np.float32)

def aug(X):
    # 회전 90°·뒤집기 (조명 방향은 어디든 가능하므로)
    X = X.reshape(-1, G, G)
    k = rng.integers(0, 4); X = np.rot90(X, k, axes=(1, 2))
    if rng.random() < 0.5: X = X[:, :, ::-1]
    return X.reshape(-1, G * G)

import os
d = [np.load(f) for f in ['d1.npz', 'd2.npz']]
X = np.concatenate([a['X'] for a in d]); y = np.concatenate([a['y'] for a in d])
# 실제 카메라 프레임에서 뽑은 데이터(여러 번 반복해 비중을 높임)
for f in [e for e in os.environ.get('EXTRA', '').split(',') if e]:
    e = np.load(f); rep = int(os.environ.get('REP', '3'))
    X = np.concatenate([X] + [e['X']] * rep); y = np.concatenate([y] + [e['y']] * rep)
RV = [np.load(f) for f in os.environ.get('RVAL', '').split(',') if f]
v = np.load('dval.npz'); Xv, yv = feats(v['X']), v['y']
D = X.shape[1] + 3
H1, H2 = int(sys.argv[2]) if len(sys.argv) > 2 else 32, int(sys.argv[3]) if len(sys.argv) > 3 else 16
W1 = rng.normal(0, np.sqrt(2 / D), (D, H1)).astype(np.float32); b1 = np.zeros(H1, np.float32)
W2 = rng.normal(0, np.sqrt(2 / H1), (H1, H2)).astype(np.float32); b2 = np.zeros(H2, np.float32)
W3 = rng.normal(0, np.sqrt(1 / H2), (H2, 1)).astype(np.float32); b3 = np.zeros(1, np.float32)
P = [W1, b1, W2, b2, W3, b3]
Mo = [np.zeros_like(p) for p in P]; Vo = [np.zeros_like(p) for p in P]
lr, wd, bs, t = 2e-3, 1e-4, 256, 0

def fwd(F, P):
    W1, b1, W2, b2, W3, b3 = P
    h1 = np.maximum(F @ W1 + b1, 0); h2 = np.maximum(h1 @ W2 + b2, 0)
    z = (h2 @ W3 + b3)[:, 0]
    return h1, h2, z

def evaluate():
    _, _, z = fwd(Xv, P); p = 1 / (1 + np.exp(-z))
    acc = ((p > 0.5) == (yv > 0.5)).mean()
    fn = ((p < 0.08) & (yv > 0.5)).sum() / (yv > 0.5).sum()   # 공을 '확실히 아님'으로 버리는 비율(앱의 제외 기준 0.08)
    fp = ((p > 0.5) & (yv < 0.5)).sum() / (yv < 0.5).sum()
    for rv in RV:
        _, _, zr = fwd(feats(rv['X']), P); pr = 1 / (1 + np.exp(-zr)); yr = rv['y']
        print(f'   실제검증: 정확도 {((pr > 0.5) == (yr > 0.5)).mean() * 100:.1f}%  공 평균확률 {pr[yr > 0.5].mean():.2f}  공 놓침(p<0.08) {(pr[yr > 0.5] < 0.08).mean() * 100:.1f}%  오인식(p>0.5) {(pr[yr < 0.5] > 0.5).mean() * 100:.1f}%', flush=True)
    return acc, fn, fp

EP = int(sys.argv[1]) if len(sys.argv) > 1 else 30
for ep in range(EP):
    idx = rng.permutation(len(X))
    for k in range(0, len(X), bs):
        bi = idx[k:k + bs]
        F = feats(aug(X[bi])); yb = y[bi]
        h1, h2, z = fwd(F, P)
        p = 1 / (1 + np.exp(-z)); g = (p - yb)[:, None] / len(bi)
        gW3 = h2.T @ g; gb3 = g.sum(0)
        g2 = (g @ W3.T) * (h2 > 0); gW2 = h1.T @ g2; gb2 = g2.sum(0)
        g1 = (g2 @ W2.T) * (h1 > 0); gW1 = F.T @ g1; gb1 = g1.sum(0)
        grads = [gW1 + wd * W1, gb1, gW2 + wd * W2, gb2, gW3 + wd * W3, gb3]
        t += 1
        for i, (p_, g_) in enumerate(zip(P, grads)):
            Mo[i] = 0.9 * Mo[i] + 0.1 * g_; Vo[i] = 0.999 * Vo[i] + 0.001 * g_ * g_
            p_ -= lr * (Mo[i] / (1 - 0.9 ** t)) / (np.sqrt(Vo[i] / (1 - 0.999 ** t)) + 1e-8)
    if ep in (EP // 2, int(EP * 0.8)): lr *= 0.3
    acc, fn, fp = evaluate()
    print(f'epoch {ep + 1:2d}  검증 정확도 {acc * 100:.2f}%  공 놓침(p<0.08) {fn * 100:.2f}%  오인식(p>0.5) {fp * 100:.2f}%', flush=True)

out = {'G': G, 'span': 1.3, 'H1': H1, 'H2': H2, 'W1': np.round(W1, 4).ravel().tolist(), 'b1': np.round(b1, 4).tolist(),
       'W2': np.round(W2, 4).ravel().tolist(), 'b2': np.round(b2, 4).tolist(), 'W3': np.round(W3, 4).ravel().tolist(), 'b3': np.round(b3, 4).tolist()}
json.dump(out, open('ballnet.json', 'w'))
np.savez('ballnet_params.npz', *P)
print('saved ballnet.json')
