"""给挂件形象抠透明背景 + 清理边缘残留 + 裁剪 + 缩放。

用法:
  python cutout.py <源图> <输出png> [目标高度] [mode]

  mode: base(默认,质量好) / fast

为什么需要"边缘清理"：transparent_background 对**深色星空背景**这类底图会漏抠，
本机实测原图底部一整块背景被留成不透明（在深色页面上看就是一条浅色横带）。
这里从四边向内，把"几乎整行/整列都不透明"的边缘条带清掉 —— 角色是中央构图，
这种整行铺满的边缘只可能是背景残留。
"""
import sys
import os

import numpy as np
from PIL import Image
from transparent_background import Remover


def strip_edge_background(im, line_ratio=0.86, max_strip_frac=0.32):
    """从四边向内清除"整行/整列几乎全不透明"的背景残留。返回清掉的行列数。"""
    a = np.array(im)
    h, w = a.shape[:2]
    alpha = a[:, :, 3]
    lim_y = int(h * max_strip_frac)
    lim_x = int(w * max_strip_frac)
    removed = {'bottom': 0, 'top': 0, 'left': 0, 'right': 0}

    # 行方向（底 / 顶）
    for side in ('bottom', 'top'):
        n = 0
        while n < lim_y:
            y = h - 1 - n if side == 'bottom' else n
            if (alpha[y] > 32).sum() <= w * line_ratio:
                break
            a[y, :, 3] = 0
            n += 1
        removed[side] = n
    # 列方向（左 / 右）—— 用更新后的 alpha
    alpha = a[:, :, 3]
    for side in ('left', 'right'):
        n = 0
        while n < lim_x:
            x = n if side == 'left' else w - 1 - n
            if (alpha[:, x] > 32).sum() <= h * line_ratio:
                break
            a[:, x, 3] = 0
            n += 1
        removed[side] = n
    return Image.fromarray(a, 'RGBA'), removed


def main():
    src = sys.argv[1]
    dst = sys.argv[2]
    target_h = int(sys.argv[3]) if len(sys.argv) > 3 else 480
    mode = sys.argv[4] if len(sys.argv) > 4 else 'base'

    img = Image.open(src).convert('RGB')
    print('src', img.size, 'mode', mode)

    remover = Remover(mode=mode)
    out = remover.process(img, type='rgba')
    out, removed = strip_edge_background(out)
    print('edge-strip', removed)

    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    print('cropped', out.size)

    if out.height > 0:
        w = max(1, int(round(out.width * target_h / out.height)))
        out = out.resize((w, target_h), Image.LANCZOS)

    os.makedirs(os.path.dirname(dst), exist_ok=True)
    out.save(dst, 'PNG')
    print('saved', dst, out.size, os.path.getsize(dst))

    # 自检：底部 30 行还有多少不透明
    a = np.array(out)
    oh, ow = a.shape[:2]
    bottom = a[oh - 30:, :, 3]
    print('bottom30-opaque-ratio', round(float((bottom > 32).mean()), 3))


if __name__ == '__main__':
    main()
