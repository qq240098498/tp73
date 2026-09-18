const crypto = require('crypto');
const {
  load,
  save,
  MAX_RULE_TEXT_LENGTH,
  MAX_RULE_NOTE_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');

// 应当统一（unify）：出现常见写法 phrase 时建议改成 replacement
// 一律不能出现（banned）：phrase 为禁用词，replacement 仅作可选的修改建议
const TYPES = new Set(['unify', 'banned']);

function ruleLabel(rule) {
  if (!rule) return '这条规则';
  if (rule.type === 'banned') return `禁用词规则「${rule.phrase}」`;
  return `统一写法规则「${rule.phrase} → ${rule.replacement}」`;
}

function validateType(value) {
  const type = pickText(value);
  if (!type) throw new ApiError(400, 'RULE_TYPE_REQUIRED', '请选择规则类型：应当统一或不能出现', 'type');
  if (!TYPES.has(type)) {
    throw new ApiError(400, 'RULE_TYPE_INVALID', '规则类型只能是“应当统一”或“不能出现”', 'type');
  }
  return type;
}

// 命中片段两种规则都要填，且长度受限
function validatePhrase(value) {
  const phrase = pickText(value);
  if (!phrase) throw new ApiError(400, 'RULE_PHRASE_REQUIRED', '请填写要检查的写法或词语', 'phrase');
  if (phrase.length > MAX_RULE_TEXT_LENGTH) {
    throw new ApiError(400, 'RULE_PHRASE_TOO_LONG', `要检查的写法不能超过 ${MAX_RULE_TEXT_LENGTH} 个字符，当前 ${phrase.length} 个字符`, 'phrase');
  }
  return phrase;
}

// 应当改成的写法只在“应当统一”里必填；“不能出现”里选填，只作修改建议
function validateReplacement(value, type) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (type === 'unify' && !text) {
    throw new ApiError(400, 'RULE_REPLACEMENT_REQUIRED', '“应当统一”的规则必须填写应当改成的写法', 'replacement');
  }
  if (text.length > MAX_RULE_TEXT_LENGTH) {
    throw new ApiError(400, 'RULE_REPLACEMENT_TOO_LONG', `应当改成的写法不能超过 ${MAX_RULE_TEXT_LENGTH} 个字符，当前 ${text.length} 个字符`, 'replacement');
  }
  return text;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'RULE_NOTE_INVALID', '规则备注需要是文本', 'note');
  }
  if (value.length > MAX_RULE_NOTE_LENGTH) {
    throw new ApiError(400, 'RULE_NOTE_TOO_LONG', `规则备注不能超过 ${MAX_RULE_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 生效范围：all 为真表示全部语言；否则必须显式勾选至少一种已登记语言
function validateScope(raw, languages) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const all = source.all === true;
  const known = new Map();
  languages.forEach((item) => known.set(item.code.toLowerCase(), item.code));

  const picked = [];
  if (!all) {
    const list = Array.isArray(source.languages) ? source.languages : [];
    list.forEach((code) => {
      const actual = known.get(String(code).toLowerCase());
      // 生效范围里的语言没有登记过：当场拒绝并指出是哪一个
      if (!actual) {
        throw new ApiError(400, 'RULE_SCOPE_LANGUAGE_UNKNOWN', `生效范围里的语言 ${code} 没有登记过，请先在语言区登记或改选其它语言`, 'scope');
      }
      if (!picked.includes(actual)) picked.push(actual);
    });
    if (picked.length === 0) {
      throw new ApiError(400, 'RULE_SCOPE_REQUIRED', '请选择生效范围：全部语言，或至少勾选一种语言', 'scope');
    }
  }
  return { all, languages: picked };
}

// 两个语言范围有没有共同作用的语言：任一为全部语言时只看另一边是否非空
function scopesOverlap(a, b) {
  if (a.all && b.all) return true;
  if (a.all) return b.languages.length > 0;
  if (b.all) return a.languages.length > 0;
  return a.languages.some((code) => b.languages.includes(code));
}

function scopeText(scope) {
  return scope.all ? '全部语言' : scope.languages.join('、');
}

// 保存前把一条规则与清单里的其它规则对一遍：
// 1) 同类型、命中片段相同且语言范围重叠：重复规则，拒绝；
// 2) 两条“应当统一”互为正反（X→Y 与 Y→X）：按一条改完正好撞上另一条，拒绝；
// 3) “应当统一”和“不能出现”跨类型互相矛盾，有两种撞法：
//    a. 两类规则的命中片段完全相同且范围重叠，同一条译文会同时被两类命中；
//    b. 统一规则要求改成的写法本身在重叠范围上被禁用词规则禁止，改过去仍然不通过
function assertRuleConsistent(candidate, rules) {
  const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  rules.forEach((other) => {
    if (other.id === candidate.id) return;
    if (!scopesOverlap(candidate.scope, other.scope)) return;

    if (candidate.type === other.type) {
      if (sameText(candidate.phrase, other.phrase)) {
        throw new ApiError(409, 'RULE_DUPLICATED',
          `${ruleLabel(candidate)}与已有的${ruleLabel(other)}命中片段相同、生效范围（${scopeText(candidate.scope)}）重叠，请直接编辑原规则而不是再建一条`, 'phrase');
      }
      if (candidate.type === 'unify'
        && sameText(candidate.phrase, other.replacement)
        && sameText(other.phrase, candidate.replacement)) {
        throw new ApiError(409, 'RULE_CONFLICT',
          `${ruleLabel(candidate)}与${ruleLabel(other)}互为正反：按其中一条改完，正好撞上另一条要改掉的写法，请调整这两条规则`, 'replacement');
      }
      return;
    }

    // 以下是 unify 与 banned 跨类型的互相矛盾
    const unify = candidate.type === 'unify' ? candidate : other;
    const banned = candidate.type === 'banned' ? candidate : other;

    if (sameText(unify.phrase, banned.phrase)) {
      throw new ApiError(409, 'RULE_CONFLICT',
        `「${unify.phrase}」在重叠的语言范围（${scopeText(unify.scope)}）上同时被“应当统一”规则与“不能出现”规则命中，同一条译文无法同时满足两条，请调整其中一条的写法或生效范围`, 'phrase');
    }
    if (sameText(unify.replacement, banned.phrase)) {
      throw new ApiError(409, 'RULE_CONFLICT',
        `${ruleLabel(unify)}要求改成的「${unify.replacement}」，在重叠的语言范围（${scopeText(unify.scope)}）上正好被${ruleLabel(banned)}禁止，改过去仍然不通过，请换一个建议写法或调整范围`, 'replacement');
    }
  });
}

function sortRules(list) {
  const weight = { banned: 0, unify: 1 };
  return list.slice().sort((a, b) => {
    if (a.type !== b.type) return weight[a.type] - weight[b.type];
    if (a.phrase !== b.phrase) return a.phrase < b.phrase ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

function listRules() {
  const data = load();
  return { rules: sortRules(data.rules) };
}

function getRule(data, id) {
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  return found;
}

function createRule(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const type = validateType(input.type);
  const phrase = validatePhrase(input.phrase);
  const replacement = validateReplacement(input.replacement, type);
  // 两种写法填得一模一样时这条统一规则没有意义，当场拒绝
  if (type === 'unify' && phrase.trim() === replacement.trim()) {
    throw new ApiError(400, 'RULE_SAME_AS_REPLACEMENT', '常见写法与应当改成的写法填得一模一样，这条统一规则没有意义，请写出真正要改成的写法', 'replacement');
  }
  const scope = validateScope(input.scope, data.languages);
  const note = validateNote(input.note);

  const now = new Date().toISOString();
  const rule = { id: crypto.randomUUID(), type, phrase, replacement, scope, note, createdAt: now, updatedAt: now };
  assertRuleConsistent(rule, data.rules);
  data.rules.push(rule);
  save(data);
  return rule;
}

function updateRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = getRule(data, id);

  const type = input.type === undefined ? found.type : validateType(input.type);
  const phrase = input.phrase === undefined ? found.phrase : validatePhrase(input.phrase);
  // 没换类型且没提交建议写法时沿用原值；换了类型或提交了写法，都按新类型重新校验
  const replacement = (input.replacement === undefined && type === found.type)
    ? found.replacement
    : validateReplacement(input.replacement, type);
  if (type === 'unify' && phrase.trim() === replacement.trim()) {
    throw new ApiError(400, 'RULE_SAME_AS_REPLACEMENT', '常见写法与应当改成的写法填得一模一样，这条统一规则没有意义，请写出真正要改成的写法', 'replacement');
  }
  const scope = input.scope === undefined ? found.scope : validateScope(input.scope, data.languages);
  const note = input.note === undefined ? found.note : validateNote(input.note);

  const next = { ...found, type, phrase, replacement, scope, note };
  assertRuleConsistent(next, data.rules);

  found.type = type;
  found.phrase = phrase;
  found.replacement = replacement;
  found.scope = scope;
  found.note = note;
  found.updatedAt = new Date().toISOString();
  save(data);
  return found;
}

function deleteRule(id) {
  const data = load();
  const index = data.rules.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  const [removed] = data.rules.splice(index, 1);
  save(data);
  return { id: removed.id, type: removed.type, phrase: removed.phrase };
}

// 删除一种语言后，把规则指定范围里的这种语言摘掉；摘光后规则休眠（范围留空），不擅自扩成全部语言
function removeLanguageFromScopes(data, code) {
  let touched = false;
  data.rules.forEach((rule) => {
    if (rule.scope.all) return;
    const next = rule.scope.languages.filter((item) => item !== code);
    if (next.length !== rule.scope.languages.length) {
      rule.scope.languages = next;
      rule.updatedAt = new Date().toISOString();
      touched = true;
    }
  });
  return touched;
}

module.exports = {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  removeLanguageFromScopes,
  validateScope,
  scopesOverlap,
};
