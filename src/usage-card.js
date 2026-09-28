import sharp from 'sharp';

const WIDTH = 1000;
const MARGIN = 48;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

export function fmtTokens(value) {
  const n = Number(value ?? 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtNumber(value) {
  return Number(value ?? 0).toLocaleString('zh-CN');
}

export function hitRate(input, cacheRead, cacheCreation) {
  const total = input + cacheRead + cacheCreation;
  return total > 0 ? ((cacheRead / total) * 100).toFixed(1) : '0.0';
}

export function normalizedModels(response) {
  return (Array.isArray(response?.models) ? response.models : [])
    .map((model) => {
      const input = Number(model.input_tokens) || 0;
      const output = Number(model.output_tokens) || 0;
      const cacheCreation = Number(model.cache_creation_tokens) || 0;
      const cacheRead = Number(model.cache_read_tokens) || 0;
      const total = Number(model.total_tokens) || input + output + cacheCreation + cacheRead;
      return {
        name: model.model || '未知模型', input, output,
        cache: cacheCreation + cacheRead, total,
        hitRate: hitRate(input, cacheRead, cacheCreation),
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'));
}

function text(x, y, value, { size = 26, fill = '#e8eefc', weight = 400, anchor = 'start' } = {}) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function buildSvg({ title, date, heroLabel, totalTokens, overallHitRate, metrics, models, rankingStatus = "" }) {
  const headerTop = 76;
  const heroTop = 142;
  const heroHeight = 194;
  const metricTop = 364;
  const metricCardHeight = 104;
  const metricGap = 14;
  const metricRows = Math.ceil(metrics.length / 2);
  const metricsBottom = metricTop + metricRows * metricCardHeight + Math.max(0, metricRows - 1) * metricGap;
  const sectionTop = metricsBottom + 46;
  const modelTop = sectionTop + 54;
  const modelRowHeight = 140;
  const modelGap = 14;
  const height = Math.max(740, modelTop + models.length * (modelRowHeight + modelGap) + 78);

  const metricCards = metrics.map((metric, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = MARGIN + col * (CONTENT_WIDTH / 2 + metricGap / 2);
    const y = metricTop + row * (metricCardHeight + metricGap);
    const w = (CONTENT_WIDTH - metricGap) / 2;
    return `<rect x="${x}" y="${y}" width="${w}" height="${metricCardHeight}" rx="20" fill="#131d32" stroke="#263654"/>${text(x + 22, y + 38, metric.label, { size: 20, fill: '#94a5c6' })}${text(x + 22, y + 78, metric.value, { size: 28, fill: '#f2f6ff', weight: 650 })}`;
  }).join('');

  const modelCards = models.length
    ? models.map((model, index) => {
      const y = modelTop + index * (modelRowHeight + modelGap);
      const badge = index < 3 ? ['#f6c96d', '#b9c7df', '#d99465'][index] : '#263653';
      const badgeText = index < 3 ? '#182033' : '#b7c7e4';
      return `<rect x="${MARGIN}" y="${y}" width="${CONTENT_WIDTH}" height="${modelRowHeight}" rx="20" fill="#131d32" stroke="#263654"/><circle cx="${MARGIN + 28}" cy="${y + 31}" r="17" fill="${badge}"/>${text(MARGIN + 28, y + 38, String(index + 1), { size: 17, fill: badgeText, weight: 700, anchor: 'middle' })}${text(MARGIN + 60, y + 39, model.name, { size: 24, fill: '#f2f6ff', weight: 650 })}${text(WIDTH - MARGIN - 22, y + 38, `缓存命中率 ${model.hitRate}%`, { size: 19, fill: '#8be0d0', anchor: 'end' })}${text(MARGIN + 28, y + 81, `输入  ${fmtTokens(model.input)}     ·     输出  ${fmtTokens(model.output)}`, { size: 20, fill: '#c0cbe0' })}${text(MARGIN + 28, y + 116, `缓存  ${fmtTokens(model.cache)}     ·     总量  ${fmtTokens(model.total)}`, { size: 20, fill: '#c0cbe0' })}`;
    }).join('')
    : `<rect x="${MARGIN}" y="${modelTop}" width="${CONTENT_WIDTH}" height="118" rx="20" fill="#131d32" stroke="#263654"/>${text(WIDTH / 2, modelTop + 69, rankingStatus || '今日暂无模型用量', { size: 23, fill: '#94a5c6', anchor: 'middle' })}`;

  const finalHeight = height + (models.length ? 0 : 132);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${finalHeight}" viewBox="0 0 ${WIDTH} ${finalHeight}" font-family="Arial, Microsoft YaHei, WenQuanYi Zen Hei, sans-serif"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0b1220"/><stop offset="1" stop-color="#111d34"/></linearGradient><linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#63d8c6"/><stop offset="1" stop-color="#8eabff"/></linearGradient><radialGradient id="glow"><stop stop-color="#386d91" stop-opacity=".32"/><stop offset="1" stop-color="#386d91" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#bg)"/><circle cx="900" cy="80" r="280" fill="url(#glow)"/><rect x="${MARGIN}" y="38" width="7" height="44" rx="4" fill="url(#accent)"/>${text(MARGIN + 24, headerTop, title, { size: 34, weight: 700 })}${text(WIDTH - MARGIN, headerTop, date, { size: 19, fill: '#8292b1', anchor: 'end' })}<rect x="${MARGIN}" y="${heroTop}" width="${CONTENT_WIDTH}" height="${heroHeight}" rx="26" fill="#182640" stroke="#314565"/>${text(MARGIN + 30, heroTop + 43, heroLabel, { size: 19, fill: '#9cb0d1' })}${text(MARGIN + 30, heroTop + 111, totalTokens, { size: 50, fill: '#f4f7ff', weight: 700 })}${text(MARGIN + 30, heroTop + 155, 'TOKENS', { size: 15, fill: '#7588aa', weight: 700 })}<line x1="670" y1="${heroTop + 37}" x2="670" y2="${heroTop + 157}" stroke="#344765"/>${text(710, heroTop + 63, '缓存命中率', { size: 18, fill: '#9cb0d1' })}${text(710, heroTop + 116, `${overallHitRate}%`, { size: 38, fill: '#8be0d0', weight: 700 })}${metricCards}${text(MARGIN, sectionTop + 26, '今日模型用量排行', { size: 25, weight: 650 })}${text(WIDTH - MARGIN, sectionTop + 25, `${rankingStatus || `${models.length} 个模型`}`, { size: 17, fill: '#8292b1', anchor: 'end' })}${modelCards}${text(WIDTH - MARGIN, finalHeight - 28, 'sub2api · USAGE INSIGHTS', { size: 13, fill: '#5f7090', anchor: 'end' })}</svg>`;
}

export async function renderUsageCard(data) {
  return sharp(Buffer.from(buildSvg(data))).png().toBuffer();
}
