'use strict';

// Stable category ids. Labels in Russian. Aliases = explicit category words
// a user can type in the same message ("такси 900 работа" -> work).
// Keywords = auto-detection in description.
const CATEGORIES = [
  {
    id: 'cafe',
    label: 'Кафе',
    emoji: '☕',
    aliases: ['кафе', 'кофе', 'ресторан', 'столовая', 'бар', 'чайхана'],
    keywords: ['кофе', 'кафе', 'латте', 'капучино', 'ресторан', 'столовая', 'обед', 'ужин', 'завтрак', 'перекус', 'бургер', 'пицца', 'суши', 'шаурма', 'чайхана', 'капуч'],
  },
  {
    id: 'food',
    label: 'Продукты',
    emoji: '🛒',
    aliases: ['продукты', 'еда', 'магазин', 'супермаркет', 'рынок'],
    keywords: ['продукты', 'магазин', 'супермаркет', 'рынок', 'хлеб', 'молоко', 'мясо', 'овощи', 'фрукты', 'корзинка', 'ашан', 'пайкар', 'помдор'],
  },
  {
    id: 'transport',
    label: 'Транспорт',
    emoji: '🚕',
    aliases: ['транспорт', 'такси', 'дорога', 'бензин', 'проезд', 'маршрутка'],
    keywords: ['такси', 'автобус', 'маршрут', 'бензин', 'заправ', 'парков', 'метро', 'самокат', 'авиа', 'поезд', 'билет', 'яндекс', 'uber', 'yandex', 'рахш'],
  },
  {
    id: 'housing',
    label: 'Жильё',
    emoji: '🏠',
    aliases: ['жилье', 'жильё', 'квартира', 'аренда', 'жкх', 'коммуналка'],
    keywords: ['аренда', 'квартир', 'жкх', 'коммунал', 'свет', 'вода', 'газ', 'интернет', 'квартплат'],
  },
  {
    id: 'comms',
    label: 'Связь',
    emoji: '📱',
    aliases: ['связь', 'телефон', 'интернет'],
    keywords: ['телефон', 'связь', 'тариф', 'мегафон', 'билайн', 'tcell', 'babilon', 'мегабайт', 'баланс'],
  },
  {
    id: 'health',
    label: 'Здоровье',
    emoji: '💊',
    aliases: ['здоровье', 'аптека', 'врач', 'больница', 'лекарства'],
    keywords: ['аптека', 'врач', 'больниц', 'лекарств', 'анализы', 'стоматолог', 'таблетк'],
  },
  {
    id: 'clothes',
    label: 'Одежда',
    emoji: '👕',
    aliases: ['одежда', 'обувь', 'вещи'],
    keywords: ['одежда', 'обувь', 'куртка', 'джинсы', 'футболка', 'кроссовки', 'вещи', 'магазин одежды'],
  },
  {
    id: 'fun',
    label: 'Развлечения',
    emoji: '🎮',
    aliases: ['развлечения', 'досуг', 'кино', 'игры', 'отдых'],
    keywords: ['кино', 'театр', 'игры', 'подписка', 'netflix', 'spotify', 'концерт', 'боулинг', 'отдых'],
  },
  {
    id: 'work',
    label: 'Работа',
    emoji: '💼',
    aliases: ['работа', 'офис', 'бизнес'],
    keywords: ['офис', 'командиров', 'канцеляр', 'клиент'],
  },
  {
    id: 'other',
    label: 'Прочее',
    emoji: '📦',
    aliases: ['прочее', 'другое', 'разное'],
    keywords: [],
  },
];

const byId = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

function getCategory(id) {
  return byId[id] || byId.other;
}

// Lowercase, ё->е for tolerant matching.
function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

// Tokenize description into words (letters/digits).
function tokensOf(text) {
  return norm(text).split(/[^a-zа-я0-9]+/u).filter(Boolean);
}

// 1) explicit alias word (LAST one wins: "такси 900 работа" -> work),
// 2) keyword substring, else 'other'.
function detectCategory(text) {
  const t = norm(text);
  const tokens = tokensOf(t);
  const aliasCat = new Map();
  for (const c of CATEGORIES) {
    if (c.id === 'other') continue;
    for (const a of c.aliases) aliasCat.set(norm(a), c.id);
  }
  let found = null;
  for (const tok of tokens) {
    if (aliasCat.has(tok)) found = aliasCat.get(tok);
  }
  if (found) return found;
  for (const c of CATEGORIES) {
    if (c.id === 'other') continue;
    if (c.keywords.some((k) => t.includes(norm(k)))) return c.id;
  }
  return 'other';
}

module.exports = { CATEGORIES, getCategory, detectCategory, tokensOf };
