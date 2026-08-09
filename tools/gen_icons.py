#!/usr/bin/env python3
# このみ の PWA アイコンを標準ライブラリだけで生成する(keiki フォーマット準拠)。
# 使い方: cd /Users/soshi/dev/konomi && python3 tools/gen_icons.py
import math
import os
import struct
import zlib

# keiki ライトテーマのトークン
BG = (230, 231, 225)        # --kk-bg #E6E7E1
SURFACE = (242, 243, 238)   # --kk-surface #F2F3EE
BORDER = (211, 213, 203)    # --kk-border #D3D5CB
ACCENT = (168, 70, 0)       # --kk-accent #A84600


def chunk(handle, name, data):
    handle.write(struct.pack('>I', len(data)))
    handle.write(name)
    handle.write(data)
    handle.write(struct.pack('>I', zlib.crc32(name + data) & 0xffffffff))


def heart_inside(u, v):
    # ハート陰関数 (u^2 + v^2 - 1)^3 - u^2 * v^3 <= 0
    a = u * u + v * v - 1.0
    return a * a * a - u * u * v * v * v <= 0.0


def sample(x, y, size):
    cx = size * 0.5
    r = math.hypot(x - cx, y - cx)
    color = BG
    dial = size * 0.40
    if r < dial:
        color = SURFACE
    # 文字盤の縁(ヘアライン)
    if abs(r - dial) < size * 0.008:
        color = BORDER
    # ハート(文字盤中央のやや上に配置)
    hs = size * 0.235
    u = (x - cx) / hs
    v = -(y - cx * 0.985) / hs
    if heart_inside(u, v):
        color = ACCENT
    return color


def png(path, size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            # 2x2 スーパーサンプリングで縁を滑らかに
            acc = [0, 0, 0]
            for dx in (0.25, 0.75):
                for dy in (0.25, 0.75):
                    c = sample(x + dx, y + dy, size)
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
            row.extend((acc[0] // 4, acc[1] // 4, acc[2] // 4, 255))
        rows.append(bytes(row))
    raw = b''.join(rows)
    with open(path, 'wb') as handle:
        handle.write(b'\x89PNG\r\n\x1a\n')
        chunk(handle, b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        chunk(handle, b'IDAT', zlib.compress(raw, 9))
        chunk(handle, b'IEND', b'')
    print('生成:', path)


def main():
    os.makedirs('icons', exist_ok=True)
    png('icons/apple-touch-icon.png', 180)
    png('icons/icon-192.png', 192)
    png('icons/icon-512.png', 512)


if __name__ == '__main__':
    main()
