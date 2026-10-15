"""诊断 kitten-art.png 的 alpha 分布，找出抠图残留（白色横带）。"""
import sys
import numpy as np
from PIL import Image

p = sys.argv[1]
im = Image.open(p).convert('RGBA')
a = np.array(im)
h, w = a.shape[0], a.shape[1]
alpha = a[:, :, 3]
print('尺寸', w, 'x', h)

opaque_rows = (alpha > 32).sum(axis=1)
print('\n--- 底部 50 行：不透明像素数 / 该行平均色 ---')
for y in range(max(0, h - 50), h):
    n = int(opaque_rows[y])
    if n > 0:
        rgb = a[y, alpha[y] > 32][:, :3].mean(axis=0).round(0).astype(int)
    else:
        rgb = [0, 0, 0]
    if (h - y) % 2 == 0 or n > 0:
        print(f'  y={y:3d}  不透明={n:4d}/{w}  平均色={tuple(rgb)}')

# 找"整行几乎全不透明、且颜色接近白"的带
print('\n--- 可疑白带（整行 ≥90% 不透明且平均亮度 > 200）---')
sus = []
for y in range(h):
    n = int(opaque_rows[y])
    if n >= w * 0.9:
        rgb = a[y, alpha[y] > 32][:, :3].mean(axis=0)
        if rgb.mean() > 200:
            sus.append(y)
if sus:
    print('  行范围:', sus[0], '→', sus[-1], '（共', len(sus), '行）')
else:
    print('  没有找到')

# 最底部 40 行的不透明比例
bottom = opaque_rows[-40:]
print('\n底部 40 行不透明比例:', (bottom.mean() / w).round(3))
