import sharp from 'sharp';

const WIDTH = 1000;
const MARGIN = 40;
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
        name: model.model || '未知模型', input, output, cache: cacheCreation + cacheRead, total,
        hitRate: hitRate(input, cacheRead, cacheCreation),
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'));
}

function text(x, y, value, { size = 24, fill = '#354252', weight = 400, anchor = 'start' } = {}) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function shorten(value, max = 28) {
  const chars = [...String(value ?? '')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function renderMetricRow(metrics, y) {
  const gap = 14;
  const cardWidth = (CONTENT_WIDTH - gap * 2) / 3;
  const height = 82;
  const cards = metrics.map((metric, index) => {
    const x = MARGIN + index * (cardWidth + gap);
    return `<rect x="${x}" y="${y}" width="${cardWidth}" height="${height}" rx="17" fill="#f4f9fc"/>${text(x + 18, y + 29, metric.label, { size: 16, fill: '#71808c', weight: 600 })}${text(x + 18, y + 62, metric.value, { size: 23, fill: '#27384a', weight: 800 })}`;
  }).join('');
  return { cards, bottom: y + height };
}

function renderExtraMetrics(metrics, y) {
  if (!metrics?.length) return { cards: '', bottom: y };
  const columns = 3;
  const gap = 12;
  const height = 70;
  const cardWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const rows = Math.ceil(metrics.length / columns);
  const cards = metrics.map((metric, index) => {
    const x = MARGIN + (index % columns) * (cardWidth + gap);
    const top = y + Math.floor(index / columns) * (height + gap);
    return `<rect x="${x}" y="${top}" width="${cardWidth}" height="${height}" rx="15" fill="#fffafd" stroke="#f7dce6"/>${text(x + 15, top + 26, metric.label, { size: 14, fill: '#89939a', weight: 600 })}${text(x + 15, top + 53, metric.value, { size: 19, fill: '#344252', weight: 750 })}`;
  }).join('');
  return { cards, bottom: y + rows * height + (rows - 1) * gap };
}

function renderModelCard(model, index, y) {
  const x = MARGIN;
  const width = CONTENT_WIDTH;
  const height = 142;
  const top = y;
  const left = x + 20;
  const right = x + width - 20;
  const mid = x + width / 2;
  return `<rect x="${x + 4}" y="${top + 5}" width="${width}" height="${height}" rx="20" fill="#f8d9e3"/><rect x="${x}" y="${top}" width="${width}" height="${height}" rx="20" fill="url(#modelFill)" stroke="#75c487" stroke-width="2"/><rect x="${left}" y="${top + 17}" width="34" height="34" rx="11" fill="#e85582"/>${text(left + 17, top + 41, String(index + 1), { size: 19, fill: '#ffffff', weight: 800, anchor: 'middle' })}${text(left + 48, top + 41, shorten(model.name), { size: 22, fill: '#26394b', weight: 800 })}<rect x="${right - 126}" y="${top + 18}" width="126" height="32" rx="16" fill="#eff9f1" stroke="#b8e0c0"/>${text(right - 63, top + 39, `命中 ${model.hitRate}%`, { size: 16, fill: '#29964a', weight: 750, anchor: 'middle' })}<line x1="${left}" y1="${top + 64}" x2="${right}" y2="${top + 64}" stroke="#f0cbd7" stroke-width="1.5" stroke-dasharray="5 5"/>${text(left, top + 89, '输入', { size: 15, fill: '#82909b', weight: 600 })}${text(mid - 15, top + 89, fmtTokens(model.input), { size: 16, fill: '#27384a', weight: 800, anchor: 'end' })}${text(mid + 8, top + 89, '输出', { size: 15, fill: '#82909b', weight: 600 })}${text(right, top + 89, fmtTokens(model.output), { size: 16, fill: '#27384a', weight: 800, anchor: 'end' })}<line x1="${left}" y1="${top + 101}" x2="${right}" y2="${top + 101}" stroke="#f0cbd7" stroke-width="1" stroke-dasharray="4 5"/>${text(left, top + 126, '缓存', { size: 15, fill: '#82909b', weight: 600 })}${text(mid - 15, top + 126, fmtTokens(model.cache), { size: 16, fill: '#27384a', weight: 800, anchor: 'end' })}${text(mid + 8, top + 126, '总量', { size: 15, fill: '#82909b', weight: 600 })}${text(right, top + 126, fmtTokens(model.total), { size: 16, fill: '#2caa54', weight: 800, anchor: 'end' })}`;
}

function buildSvg({
  title, heroLabel, totalTokens, overallHitRate,
  heroFootnote = '', heroRateFootnote = '今日累计', metrics, extraMetrics = [], models, rankingStatus = '',
}) {
  const heroTop = 126;
  const heroHeight = 145;
  const metricTop = 288;
  const { cards: metricCards, bottom: metricBottom } = renderMetricRow(metrics, metricTop);
  const { cards: extraCards, bottom: extraBottom } = renderExtraMetrics(extraMetrics, metricBottom + 12);
  const sectionTop = extraBottom + 28;
  const modelTop = sectionTop + 44;
  const modelHeight = 142;
  const modelGap = 12;
  const emptyHeight = 92;
  const modelBottom = models.length
    ? modelTop + models.length * modelHeight + (models.length - 1) * modelGap
    : modelTop + emptyHeight;
  const height = modelBottom + 24;

  const cards = models.length
    ? models.map((model, index) => renderModelCard(model, index, modelTop + index * (modelHeight + modelGap))).join('')
    : `<rect x="${MARGIN}" y="${modelTop}" width="${CONTENT_WIDTH}" height="${emptyHeight}" rx="18" fill="#f0f8fc" stroke="#f1bfd1" stroke-width="2" stroke-dasharray="7 6"/>${text(WIDTH / 2, modelTop + 55, rankingStatus || '今日暂无模型用量', { size: 18, fill: '#8b969c', weight: 700, anchor: 'middle' })}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Arial, Microsoft YaHei, WenQuanYi Zen Hei, sans-serif"><defs><linearGradient id="page" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fffdfd"/><stop offset="1" stop-color="#fffafd"/></linearGradient><linearGradient id="pink" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff0f5"/><stop offset="1" stop-color="#ffeef4"/></linearGradient><linearGradient id="green" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1faf2"/><stop offset="1" stop-color="#edf8ef"/></linearGradient><linearGradient id="modelFill" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#f5fbf6"/></linearGradient></defs><rect x="2" y="2" width="996" height="${height - 4}" rx="27" fill="url(#page)" stroke="#f5c9d8" stroke-width="3"/><rect x="40" y="32" width="54" height="54" rx="17" fill="#e85a86"/>${text(67, 68, '✦', { size: 28, fill: '#ffffff', weight: 700, anchor: 'middle' })}${text(112, 58, title, { size: 30, fill: '#e55280', weight: 800 })}<line x1="3" y1="100" x2="997" y2="100" stroke="#f3cada" stroke-width="2" stroke-dasharray="6 5"/><rect x="${MARGIN}" y="${heroTop}" width="535" height="${heroHeight}" rx="20" fill="url(#pink)" stroke="#f6d2de"/><rect x="590" y="${heroTop}" width="370" height="${heroHeight}" rx="20" fill="url(#green)" stroke="#d4ead8"/>${text(MARGIN + 20, heroTop + 31, heroLabel, { size: 16, fill: '#78838d', weight: 700 })}${text(MARGIN + 20, heroTop + 80, totalTokens, { size: 39, fill: '#e55280', weight: 800 })}${text(MARGIN + 20, heroTop + 123, heroFootnote, { size: 14, fill: '#7a8790', weight: 650 })}${text(610, heroTop + 31, '缓存命中率', { size: 16, fill: '#78838d', weight: 700 })}${text(610, heroTop + 82, `${overallHitRate}%`, { size: 38, fill: '#37a75a', weight: 800 })}${text(940, heroTop + 122, heroRateFootnote, { size: 13, fill: '#7c898f', weight: 650, anchor: 'end' })}${metricCards}${extraCards}<line x1="${MARGIN}" y1="${sectionTop - 12}" x2="${WIDTH - MARGIN}" y2="${sectionTop - 12}" stroke="#f2c7d5" stroke-width="1.5" stroke-dasharray="6 5"/>${text(MARGIN, sectionTop + 20, '今日模型用量排行', { size: 22, fill: '#e55280', weight: 750 })}<rect x="${WIDTH - MARGIN - 124}" y="${sectionTop - 1}" width="124" height="30" rx="15" fill="#f1f9ff" stroke="#b9dff6"/>${text(WIDTH - MARGIN - 62, sectionTop + 19, rankingStatus || '按总 Token 排序', { size: 13, fill: '#3793ca', weight: 700, anchor: 'middle' })}${cards}</svg>`;
}

export async function renderUsageCard(data) {
  return sharp(Buffer.from(buildSvg(data))).png().toBuffer();
}