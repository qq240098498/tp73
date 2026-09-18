const { load } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一次检查的语言范围：不填或 all 为真表示全部已登记语言；否则逐种语言核对是否登记过
function resolveCheckScope(raw, languages) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // 什么都不传时默认检查全部语言；显式传了 languages 列表（即使不带 all）就按列表走
  if (source.all === true || (source.all === undefined && !Array.isArray(source.languages))) {
    return { all: true, languages: languages.map((item) => item.code) };
  }
  const known = new Map();
  languages.forEach((item) => known.set(item.code.toLowerCase(), item.code));
  const picked = [];
  (Array.isArray(source.languages) ? source.languages : []).forEach((code) => {
    const actual = known.get(String(code).toLowerCase());
    if (!actual) {
      throw new ApiError(400, 'CHECK_SCOPE_LANGUAGE_UNKNOWN', `检查范围里的语言 ${code} 没有登记过，请先在语言区登记或改选其它语言`, 'checkScope');
    }
    if (!picked.includes(actual)) picked.push(actual);
  });
  if (picked.length === 0) {
    throw new ApiError(400, 'CHECK_SCOPE_REQUIRED', '请选择检查范围：全部语言，或至少勾选一种语言', 'checkScope');
  }
  return { all: false, languages: picked };
}

// 规则在某种语言上是否生效：全部语言规则对任何语言生效；指定语言只对手勾的语言生效
function ruleAppliesToLanguage(rule, code) {
  if (rule.scope.all) return true;
  return rule.scope.languages.includes(code);
}

// 找出 fragment 在 text 里的每一次出现，空片段不参与匹配（数据被手工改坏时也不会误报）
function indexOccurrences(text, fragment) {
  if (!fragment) return [];
  const positions = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(fragment, from);
    if (at === -1) break;
    positions.push(at);
    from = at + fragment.length;
  }
  return positions;
}

// 选定模块与语言范围执行一次检查：逐条文案、逐种语言、逐条规则扫描，
// 同一片段出现几次就列出几条，写清文案键、语言、命中片段与命中的规则
function runCheck(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const module = pickText(input.module);
  const scope = resolveCheckScope(input.scope, data.languages);

  const entries = data.entries
    .filter((item) => !module || item.module === module)
    .slice()
    .sort((a, b) => {
      if (a.module !== b.module) return a.module < b.module ? -1 : 1;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  // 生效范围与本次检查范围没有交集的规则直接跳过；规则语言顺序按语言登记表来
  const languageOrder = new Map(scope.languages.map((code, index) => [code, index]));
  const activeRules = data.rules.filter((rule) =>
    scope.languages.some((code) => ruleAppliesToLanguage(rule, code)));

  const findings = [];
  let scannedTranslations = 0;

  entries.forEach((entry) => {
    scope.languages.forEach((code) => {
      const value = entry.translations[code];
      if (typeof value !== 'string' || !value) return; // 未登记或留空待翻译的没有可检查的文字
      scannedTranslations += 1;
      activeRules.forEach((rule) => {
        if (!ruleAppliesToLanguage(rule, code)) return;
        indexOccurrences(value, rule.phrase).forEach((at) => {
          findings.push({
            entryId: entry.id,
            module: entry.module,
            key: entry.key,
            language: code,
            index: at,
            snippet: rule.phrase,
            translation: value,
            ruleId: rule.id,
            ruleType: rule.type,
            rulePhrase: rule.phrase,
            ruleReplacement: rule.replacement,
          });
        });
      });
    });
  });

  // 列表顺序：先按文案，再按语言在登记表里的次序，再按命中位置，最后禁用词排在统一写法前面
  const entryOrder = new Map(entries.map((item, index) => [item.id, index]));
  const typeWeight = { banned: 0, unify: 1 };
  findings.sort((a, b) => {
    if (a.entryId !== b.entryId) return entryOrder.get(a.entryId) - entryOrder.get(b.entryId);
    if (a.language !== b.language) return languageOrder.get(a.language) - languageOrder.get(b.language);
    if (a.index !== b.index) return a.index - b.index;
    if (a.ruleType !== b.ruleType) return typeWeight[a.ruleType] - typeWeight[b.ruleType];
    return a.ruleId < b.ruleId ? -1 : 1;
  });

  return {
    module: module || '',
    scope,
    stats: {
      entries: entries.length,
      languages: scope.languages.length,
      rules: activeRules.length,
      translations: scannedTranslations,
      findings: findings.length,
    },
    findings,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { runCheck, resolveCheckScope };
