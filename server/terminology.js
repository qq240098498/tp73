const crypto = require('crypto');
const { load, save } = require('./store');
const { ApiError, pickText } = require('./errors');

const MAX_TERM_LENGTH = 60;
const MAX_RULE_NOTE_LENGTH = 200;

// 两条规则的生效范围是否有交集：“全部语言”与任何范围都有交集，
// 否则看各自指定的语言里有没有同一种
function scopeOverlaps(a, b) {
  if (a.scopeType === 'all' || b.scopeType === 'all') return true;
  return a.languages.some((code) => b.languages.includes(code));
}

function ruleText(rule) {
  return rule.type === 'unify' ? `「${rule.from}」统一为「${rule.to}」` : `禁用词「${rule.term}」`;
}

// 取规则在某一种语言上是否生效
function appliesTo(rule, languageCode) {
  return rule.scopeType === 'all' || rule.languages.includes(languageCode);
}

function validateType(value) {
  const type = pickText(value);
  if (!type) throw new ApiError(400, 'TERM_TYPE_REQUIRED', '请选择规则类型：统一写法或禁用词', 'type');
  if (type !== 'unify' && type !== 'banned') {
    throw new ApiError(400, 'TERM_TYPE_INVALID', '规则类型只能是“统一写法”或“禁用词”', 'type');
  }
  return type;
}

// 统一写法规则里“现在常见的写法”与“应当改成的写法”各自必填，且不能填成一模一样
function validatePair(input) {
  const from = pickText(input.from);
  const to = pickText(input.to);
  if (!from) throw new ApiError(400, 'TERM_FROM_REQUIRED', '请填写现在常见的写法', 'from');
  if (!to) throw new ApiError(400, 'TERM_TO_REQUIRED', '请填写应当改成的写法', 'to');
  if (from.length > MAX_TERM_LENGTH) {
    throw new ApiError(400, 'TERM_FROM_TOO_LONG', `常见写法不能超过 ${MAX_TERM_LENGTH} 个字符，当前 ${from.length} 个字符`, 'from');
  }
  if (to.length > MAX_TERM_LENGTH) {
    throw new ApiError(400, 'TERM_TO_TOO_LONG', `目标写法不能超过 ${MAX_TERM_LENGTH} 个字符，当前 ${to.length} 个字符`, 'to');
  }
  if (from === to) {
    throw new ApiError(400, 'TERM_SAME_FORM', '现在常见的写法与应当改成的写法填得一模一样，这条规则没有可改的内容', 'to');
  }
  return { from, to };
}

function validateBannedTerm(input) {
  const term = pickText(input.term);
  if (!term) throw new ApiError(400, 'TERM_WORD_REQUIRED', '请填写一律不能出现的词语', 'term');
  if (term.length > MAX_TERM_LENGTH) {
    throw new ApiError(400, 'TERM_WORD_TOO_LONG', `禁用词不能超过 ${MAX_TERM_LENGTH} 个字符，当前 ${term.length} 个字符`, 'term');
  }
  return term;
}

// 生效范围：选全部语言，或在已登记语言里勾几种；勾空了、勾了没登记过的语言都不成立
function validateScope(input, data) {
  const scopeType = pickText(input.scopeType) === 'all' ? 'all' : 'languages';
  if (scopeType === 'all') return { scopeType: 'all', languages: [] };

  const raw = Array.isArray(input.languages) ? input.languages : [];
  const languages = [...new Set(raw.map((code) => pickText(code)).filter(Boolean))];
  if (!languages.length) {
    throw new ApiError(400, 'TERM_SCOPE_EMPTY', '生效范围不能留空：选全部语言，或至少勾选一种语言', 'languages');
  }
  const known = new Set(data.languages.map((item) => item.code));
  const unknown = languages.find((code) => !known.has(code));
  if (unknown) {
    throw new ApiError(400, 'LANGUAGE_UNKNOWN', `生效范围里的语言 ${unknown} 没有登记过，请先在语言区登记或改选其他语言`, 'languages');
  }
  return { scopeType, languages };
}

function validateRuleNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'TERM_NOTE_INVALID', '规则说明需要是文本', 'note');
  }
  if (value.length > MAX_RULE_NOTE_LENGTH) {
    throw new ApiError(400, 'TERM_NOTE_TOO_LONG', `规则说明不能超过 ${MAX_RULE_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 把一条待保存的规则与同一生效范围内的其他规则对一遍：
// 重复的禁用词、同一个常见写法对应两个目标写法、目标写法又是另一条的常见写法、
// 以及同一条译文会同时被“应当统一”和“不能出现”两类规则命中，一律当场拒绝
function assertNoConflict(candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (!scopeOverlaps(a, b)) continue;

      if (a.type === 'banned' && b.type === 'banned') {
        if (a.term === b.term) {
          throw new ApiError(409, 'TERM_DUPLICATED', `禁用词「${a.term}」已经有一条规则在重叠的生效范围内，请直接编辑原规则而不是再建一条`, 'term');
        }
        continue;
      }

      if (a.type === 'unify' && b.type === 'unify') {
        if (a.from === b.from) {
          if (a.to === b.to) {
            throw new ApiError(409, 'TERM_DUPLICATED', `「${a.from}」统一为「${a.to}」已经有一条规则在重叠的生效范围内，请直接编辑原规则`, 'from');
          }
          throw new ApiError(409, 'TERM_TARGET_CONFLICT', `常见写法「${a.from}」在同一语言下被要求改成两种写法：「${a.to}」和「${b.to}」，请先统一口径`, 'to');
        }
        if (a.to === b.from || b.to === a.from) {
          const chained = a.to === b.from ? b : a;
          const other = chained === a ? b : a;
          throw new ApiError(409, 'TERM_CHAIN_CONFLICT', `「${chained.from}」既是一条规则要改成的写法，又是另一条规则里的常见写法（${ruleText(other)}），改完还会再命中一次，请合并成一条规则`, 'to');
        }
        continue;
      }

      // 一条统一写法、一条禁用词：禁用片段与常见写法或目标写法只要互相包含，
      // 同一条译文（含较长那个片段的文案）就必然同时被两类规则命中
      const unify = a.type === 'unify' ? a : b;
      const banned = a.type === 'banned' ? a : b;
      const hitFrom = banned.term === unify.from
        || unify.from.includes(banned.term)
        || banned.term.includes(unify.from);
      const hitTo = banned.term === unify.to
        || unify.to.includes(banned.term)
        || banned.term.includes(unify.to);
      if (hitFrom || hitTo) {
        const where = hitFrom ? '现在常见的写法' : '应当改成的写法';
        throw new ApiError(
          409,
          'TERM_CROSS_CONFLICT',
          `同一条译文会同时命中两类规则：禁用词「${banned.term}」与统一规则「${unify.from}→${unify.to}」里${where}的片段互相包含，无法同时满足，请调整其中一条`,
          'term',
        );
      }
    }
  }
}

// 组装规则内容（不查冲突），新增与修改共用
function buildRule(input, data) {
  const type = validateType(input.type);
  const scope = validateScope(input, data);
  const note = validateRuleNote(input.note);
  if (type === 'unify') {
    const pair = validatePair(input);
    return { type, ...pair, ...scope, note };
  }
  return { type, term: validateBannedTerm(input), ...scope, note };
}

// 用待保存的规则替换（或追加）到现有清单后做整表冲突检查
function validateAgainstRules(data, fields, selfId) {
  const candidate = { id: selfId || 'candidate', ...fields };
  const others = data.termRules.filter((rule) => rule.id !== selfId);
  assertNoConflict([...others, candidate]);
}

function listTermRules() {
  const data = load();
  return { rules: data.termRules };
}

function getRule(data, id) {
  const found = data.termRules.find((rule) => rule.id === id);
  if (!found) throw new ApiError(404, 'TERM_RULE_NOT_FOUND', '这条用语规则不存在或已被删除', '');
  return found;
}

function createTermRule(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const fields = buildRule(input, data);
  validateAgainstRules(data, fields, '');

  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...fields, createdAt: now, updatedAt: now };
  data.termRules.push(created);
  save(data);
  return created;
}

function updateTermRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = getRule(data, id);

  const nextType = input.type === undefined ? found.type : validateType(input.type);
  // 生效范围与文案译文一样整组替换，未提交时沿用原范围
  const scopeInput = input.scopeType === undefined
    ? { scopeType: found.scopeType, languages: found.languages }
    : input;
  const scope = validateScope(scopeInput, data);
  const note = input.note === undefined ? found.note : validateRuleNote(input.note);

  let fields;
  if (nextType === 'unify') {
    fields = {
      type: 'unify',
      from: input.from === undefined ? found.from : input.from,
      to: input.to === undefined ? found.to : input.to,
    };
    const pair = validatePair(fields);
    fields = { type: 'unify', ...pair, ...scope, note };
  } else {
    fields = {
      type: 'banned',
      term: input.term === undefined ? (found.type === 'banned' ? found.term : '') : input.term,
    };
    fields = { type: 'banned', term: validateBannedTerm(fields), ...scope, note };
  }
  validateAgainstRules(data, fields, id);

  // 类型可能从禁用词切成统一写法，把旧类型遗留的字段摘掉再写入
  const next = { ...found, ...fields, updatedAt: new Date().toISOString() };
  if (next.type === 'unify') delete next.term;
  if (next.type === 'banned') {
    delete next.from;
    delete next.to;
  }
  const index = data.termRules.findIndex((rule) => rule.id === id);
  data.termRules[index] = next;
  save(data);
  return next;
}

function deleteTermRule(id) {
  const data = load();
  const found = getRule(data, id);
  data.termRules = data.termRules.filter((rule) => rule.id !== id);
  save(data);
  return { id: found.id };
}

// 删除语言前调用：还有规则把生效范围指到这种语言时不允许直接删
function assertLanguageFreeForRules(data, code) {
  const used = data.termRules.filter((rule) => rule.scopeType === 'languages' && rule.languages.includes(code));
  if (used.length) {
    const samples = used.slice(0, 3).map(ruleText).join('、');
    throw new ApiError(409, 'TERM_RULE_SCOPE_IN_USE', `还有 ${used.length} 条用语规则只对这种语言生效（例如 ${samples}），请先改掉这些规则的生效范围再删除语言`, 'code');
  }
}

// 在一条文本里找出片段出现的所有位置，返回相对译文开头的下标区间
function findOccurrences(text, snippet) {
  const positions = [];
  if (!snippet) return positions;
  let cursor = 0;
  let index = text.indexOf(snippet, cursor);
  while (index !== -1) {
    positions.push(index);
    cursor = index + snippet.length;
    index = text.indexOf(snippet, cursor);
  }
  return positions;
}

// 选定模块与语言范围执行一次检查，逐条返回命中的文案键、语言、片段与规则
function runTermCheck(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();

  const module = pickText(input.module);
  if (module && !data.entries.some((item) => item.module === module)) {
    throw new ApiError(400, 'CHECK_MODULE_UNKNOWN', `模块 ${module} 下没有文案，请刷新模块列表后再检查`, 'module');
  }

  // 语言范围不传或传空表示全部已登记语言；显式指定时每一种都必须登记过
  let languages;
  const rawLanguages = Array.isArray(input.languages) ? input.languages : [];
  const selected = [...new Set(rawLanguages.map((code) => pickText(code)).filter(Boolean))];
  if (selected.length) {
    const known = new Set(data.languages.map((item) => item.code));
    const unknown = selected.find((code) => !known.has(code));
    if (unknown) {
      throw new ApiError(400, 'LANGUAGE_UNKNOWN', `检查范围里的语言 ${unknown} 没有登记过`, 'languages');
    }
    languages = selected;
  } else {
    languages = data.languages.map((item) => item.code);
  }

  const entries = data.entries
    .filter((item) => !module || item.module === module)
    .slice()
    .sort((a, b) => {
      if (a.module !== b.module) return a.module < b.module ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  const hits = [];
  entries.forEach((entry) => {
    languages.forEach((languageCode) => {
      const text = entry.translations[languageCode];
      // 没登记译文或留空待翻译的格子不参与检查
      if (typeof text !== 'string' || !text) return;

      data.termRules.forEach((rule) => {
        if (!appliesTo(rule, languageCode)) return;
        const snippet = rule.type === 'unify' ? rule.from : rule.term;
        findOccurrences(text, snippet).forEach((index) => {
          hits.push({
            entryId: entry.id,
            module: entry.module,
            key: entry.key,
            language: languageCode,
            translation: text,
            snippet,
            index,
            length: snippet.length,
            ruleId: rule.id,
            ruleType: rule.type,
            ruleLabel: ruleText(rule),
            suggest: rule.type === 'unify' ? rule.to : '',
          });
        });
      });
    });
  });

  // 同一条译文里的命中按下标排到一起，不同译文之间按文案键与语言排列
  hits.sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.language !== b.language) return a.language < b.language ? -1 : 1;
    if (a.index !== b.index) return a.index - b.index;
    return a.ruleId < b.ruleId ? -1 : 1;
  });

  return {
    scope: { module: module || '', languages },
    checkedEntries: entries.length,
    checkedLanguages: languages.length,
    total: hits.length,
    hits,
  };
}

module.exports = {
  listTermRules,
  createTermRule,
  updateTermRule,
  deleteTermRule,
  assertLanguageFreeForRules,
  runTermCheck,
  ruleText,
};
