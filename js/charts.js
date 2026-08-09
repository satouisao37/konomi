'use strict';
// このみ — SVG チャート層。データ → SVG 文字列の純粋関数のみ(DOM 禁止)。
// 色は CSS クラス経由(style.css のトークンを参照)でテーマ非依存にする。
var KONOMI = (typeof globalThis !== 'undefined' && globalThis.KONOMI) ? globalThis.KONOMI : {};
if (typeof globalThis !== 'undefined') globalThis.KONOMI = KONOMI;

KONOMI.charts = (function () {

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function scoreClass(score) {
    if (score === 2) return 'sc-p2';
    if (score === 1) return 'sc-p1';
    if (score === -1) return 'sc-m1';
    return 'sc-m2';
  }

  function polar(cx, cy, r, deg) {
    var rad = (deg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(cx, cy, r, startDeg, endDeg) {
    var s = polar(cx, cy, r, startDeg);
    var e = polar(cx, cy, r, endDeg);
    var large = endDeg - startDeg > 180 ? 1 : 0;
    return 'M ' + s.x.toFixed(2) + ' ' + s.y.toFixed(2)
      + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + e.x.toFixed(2) + ' ' + e.y.toFixed(2);
  }

  // このみ計: 270° アークフィルゲージ(keiki のヒーローコンポーネント)
  // track = --kk-surface-2 / fill = --kk-accent / 中央に % を data-xl で表示
  function gaugeSVG(percent, caption) {
    var start = -135;
    var end = 135;
    var p = Math.max(0, Math.min(100, percent));
    var fillEnd = start + (end - start) * p / 100;
    var svg = '<svg class="gauge" viewBox="0 0 200 200" role="img" aria-label="陽性度 ' + p + '%">'
      + '<path class="gauge-track" d="' + arcPath(100, 100, 80, start, end) + '"/>';
    if (p > 0) {
      svg += '<path class="gauge-fill" d="' + arcPath(100, 100, 80, start, Math.max(fillEnd, start + 1)) + '"/>';
    }
    svg += '<text class="gauge-num" x="100" y="104" text-anchor="middle">' + p + '<tspan class="gauge-unit">%</tspan></text>'
      + '<text class="gauge-cap" x="100" y="132" text-anchor="middle">' + esc(caption) + '</text>'
      + '</svg>';
    return svg;
  }

  // スコアピップ: 4分割ピル。該当セルだけスコア色で塗る
  function pipSVG(score) {
    var cells = [-2, -1, 1, 2];
    var w = 13;
    var gap = 2;
    var svg = '<svg class="pip" viewBox="0 0 ' + (cells.length * w + (cells.length - 1) * gap) + ' 12" aria-hidden="true">';
    for (var i = 0; i < cells.length; i++) {
      var x = i * (w + gap);
      var on = cells[i] === score;
      svg += '<rect class="pip-cell' + (on ? ' ' + scoreClass(cells[i]) : '') + '" x="' + x + '" y="1" width="' + w + '" height="10" rx="5"/>';
    }
    return svg + '</svg>';
  }

  // 発散型積み上げ横棒の1行分(中央0軸。左=嫌い側 −1,−2 / 右=好き側 +1,+2)
  // unit = 1件あたりの px 幅(全行共通スケール。呼び出し側が最大件数から算出)
  function divergingRowSVG(counts, unit) {
    var W = 320;
    var H = 24;
    var mid = W / 2;
    var barH = 16;
    var y = (H - barH) / 2;
    var gap = 2;
    var svg = '<svg class="divrow" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<line class="divrow-axis" x1="' + mid + '" y1="0" x2="' + mid + '" y2="' + H + '"/>';
    // 左腕: 中央から −1 → −2 の順に外側へ
    var x = mid;
    if (counts.m1 > 0) {
      var w1 = counts.m1 * unit;
      x -= w1;
      svg += '<rect class="sc-m1" x="' + x.toFixed(1) + '" y="' + y + '" width="' + Math.max(w1 - gap, 1).toFixed(1) + '" height="' + barH + '"/>';
    }
    if (counts.m2 > 0) {
      var w2 = counts.m2 * unit;
      x -= w2;
      svg += '<rect class="sc-m2" x="' + x.toFixed(1) + '" y="' + y + '" width="' + Math.max(w2 - gap, 1).toFixed(1) + '" height="' + barH + '" rx="4"/>';
    }
    // 右腕: 中央から +1 → +2
    x = mid;
    if (counts.p1 > 0) {
      var w3 = counts.p1 * unit;
      svg += '<rect class="sc-p1" x="' + (x + gap).toFixed(1) + '" y="' + y + '" width="' + Math.max(w3 - gap, 1).toFixed(1) + '" height="' + barH + '"/>';
      x += w3;
    }
    if (counts.p2 > 0) {
      var w4 = counts.p2 * unit;
      svg += '<rect class="sc-p2" x="' + (x + gap).toFixed(1) + '" y="' + y + '" width="' + Math.max(w4 - gap, 1).toFixed(1) + '" height="' + barH + '" rx="4"/>';
    }
    return svg + '</svg>';
  }

  // はっきり度: 4本棒ヒストグラム(rounded-top、値をキャップ上に表示)
  function histogramSVG(counts, emojis) {
    var W = 280;
    var H = 130;
    var plotTop = 22;
    var plotBottom = 104;
    var slots = [
      { key: 'm2', cls: 'sc-m2' }, { key: 'm1', cls: 'sc-m1' },
      { key: 'p1', cls: 'sc-p1' }, { key: 'p2', cls: 'sc-p2' }
    ];
    var max = 1;
    for (var i = 0; i < slots.length; i++) max = Math.max(max, counts[slots[i].key]);
    var slotW = W / slots.length;
    var barW = 24;
    var svg = '<svg class="hist" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
      + '<line class="chart-grid" x1="8" y1="' + plotBottom + '" x2="' + (W - 8) + '" y2="' + plotBottom + '"/>';
    for (var j = 0; j < slots.length; j++) {
      var v = counts[slots[j].key];
      var cx = slotW * j + slotW / 2;
      var h = Math.round((plotBottom - plotTop) * v / max);
      if (v > 0) {
        var y = plotBottom - h;
        // 上角のみ 4px 丸め(パスで描く)
        var x0 = cx - barW / 2;
        var r = Math.min(4, h);
        svg += '<path class="' + slots[j].cls + '" d="M ' + x0 + ' ' + plotBottom
          + ' L ' + x0 + ' ' + (y + r) + ' Q ' + x0 + ' ' + y + ' ' + (x0 + r) + ' ' + y
          + ' L ' + (x0 + barW - r) + ' ' + y + ' Q ' + (x0 + barW) + ' ' + y + ' ' + (x0 + barW) + ' ' + (y + r)
          + ' L ' + (x0 + barW) + ' ' + plotBottom + ' Z"/>';
      }
      svg += '<text class="chart-val" x="' + cx + '" y="' + (plotBottom - h - 6) + '" text-anchor="middle">' + v + '</text>';
      svg += '<text class="chart-emoji" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + emojis[j] + '</text>';
    }
    return svg + '</svg>';
  }

  // 気変わりタイムライン: スロープチャート(1行=1アイテム。左=初回・右=最新)
  function slopeSVG(changes, scoreEmoji) {
    var rowH = 34;
    var W = 320;
    var H = changes.length * rowH + 8;
    var xL = 70;
    var xR = 180;
    var svg = '<svg class="slope" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">';
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i];
      var cy = i * rowH + rowH / 2 + 4;
      var yFor = function (s) { return cy - s * 5; };
      var y1 = yFor(c.first);
      var y2 = yFor(c.last);
      var lineCls = c.dir === 'up' ? 'slope-up' : 'slope-down';
      svg += '<line class="' + lineCls + '" x1="' + xL + '" y1="' + y1 + '" x2="' + xR + '" y2="' + y2 + '"/>'
        + '<circle class="slope-dot" cx="' + xL + '" cy="' + y1 + '" r="4"/>'
        + '<circle class="slope-dot ' + lineCls + '-dot" cx="' + xR + '" cy="' + y2 + '" r="4"/>'
        + '<text class="chart-emoji" x="' + (xL - 24) + '" y="' + (y1 + 5) + '" text-anchor="middle">' + scoreEmoji(c.first) + '</text>'
        + '<text class="chart-emoji" x="' + (xR + 24) + '" y="' + (y2 + 5) + '" text-anchor="middle">' + scoreEmoji(c.last) + '</text>'
        + '<text class="chart-label" x="' + (xR + 44) + '" y="' + (cy + 4) + '">' + esc(truncate(c.name, 9)) + '</text>';
    }
    return svg + '</svg>';
  }

  // 進捗カプセル(current / threshold)。fill = --kk-accent
  function progressSVG(current, threshold) {
    var W = 200;
    var H = 10;
    var p = Math.max(0, Math.min(1, threshold ? current / threshold : 0));
    var w = Math.round((W - 2) * p);
    var svg = '<svg class="cap-meter" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<rect class="cap-track" x="0" y="0" width="' + W + '" height="' + H + '" rx="' + (H / 2) + '"/>';
    if (w > 0) {
      svg += '<rect class="cap-fill" x="1" y="1" width="' + Math.max(w, 8) + '" height="' + (H - 2) + '" rx="' + ((H - 2) / 2) + '"/>';
    }
    return svg + '</svg>';
  }

  // 汎用カプセルメーター(はっきり度サブメーターなど)。cls でスコア色を指定可
  function meterSVG(percent, cls) {
    var W = 200;
    var H = 10;
    var w = Math.round((W - 2) * Math.max(0, Math.min(100, percent)) / 100);
    var svg = '<svg class="cap-meter" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<rect class="cap-track" x="0" y="0" width="' + W + '" height="' + H + '" rx="' + (H / 2) + '"/>';
    if (w > 0) {
      svg += '<rect class="' + (cls || 'cap-fill') + '" x="1" y="1" width="' + Math.max(w, 8) + '" height="' + (H - 2) + '" rx="' + ((H - 2) / 2) + '"/>';
    }
    return svg + '</svg>';
  }

  function truncate(s, len) {
    s = String(s);
    return s.length > len ? s.slice(0, len) + '…' : s;
  }

  return {
    esc: esc,
    scoreClass: scoreClass,
    gaugeSVG: gaugeSVG,
    pipSVG: pipSVG,
    divergingRowSVG: divergingRowSVG,
    histogramSVG: histogramSVG,
    slopeSVG: slopeSVG,
    progressSVG: progressSVG,
    meterSVG: meterSVG,
    truncate: truncate
  };
})();
