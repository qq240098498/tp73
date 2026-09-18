// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  rules: [],
  editingRuleId: '',
  checkResult: null,
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：语言区、文案区、规则区共用一套标记。
// 文案备注与规则备注都叫 note，因此优先标到当前可见的那个，避免标到隐藏表单上
function markField(field) {
  if (!field) return;
  const targets = document.querySelectorAll(`[data-field="${field}"]`);
  if (!targets.length) return;
  let target = null;
  targets.forEach((node) => {
    if (!target && node.offsetParent !== null) target = node;
  });
  if (!target) target = targets[0];
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' ? target : target.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'i18n-workbench-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  const saved = window.localStorage.getItem(OPERATOR_KEY) || '';
  el('operator').value = saved;
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadLanguages() {
  const payload = await request('/api/languages');
  state.languages = payload.languages || [];
  renderLanguages();
  renderTranslationInputs();
  refreshLanguagePickers();
}

// 语言清单变化后刷新规则表单与检查条上的语言勾选，已经勾上的语言尽量保留
function refreshLanguagePickers() {
  [['rule-scope-languages'], ['check-scope-languages']].forEach(([containerId]) => {
    const box = el(containerId);
    if (!box) return;
    const checked = new Set(Array.from(box.querySelectorAll('input:checked')).map((input) => input.value));
    languageCheckboxes(containerId, Array.from(checked));
  });
  // 重建勾选框后按当前单选状态重新决定容器是否禁用
  syncRuleScopeUI();
  syncCheckScopeUI();
}

async function loadEntries() {
  const params = new URLSearchParams();
  const module = el('filter-module').value;
  const keyword = el('filter-keyword').value.trim();
  if (module) params.set('module', module);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/entries${query ? `?${query}` : ''}`);
  state.entries = payload.entries || [];
  state.modules = payload.modules || [];
  renderModules();
  renderEntries();
}

function renderModules() {
  const options = ['<option value="">全部模块</option>']
    .concat(state.modules.map((item) => `<option value="${escapeHtml(item.module)}">${escapeHtml(item.module)}（${item.count}）</option>`));
  const html = options.join('');

  const filterSelect = el('filter-module');
  const filterCurrent = filterSelect.value;
  filterSelect.innerHTML = html;
  if (state.modules.some((item) => item.module === filterCurrent)) filterSelect.value = filterCurrent;

  // 检查条上的模块下拉共用同一份模块清单，尽量保留用户已经选中的模块
  const checkSelect = el('check-module');
  const checkCurrent = checkSelect.value;
  checkSelect.innerHTML = html;
  if (state.modules.some((item) => item.module === checkCurrent)) checkSelect.value = checkCurrent;
}

function renderLanguages() {
  const body = el('language-body');
  const rows = state.languages.map((item) => {
    const defaultTag = item.isDefault ? '<span class="tag on">默认</span>' : '';
    const enabledTag = item.enabled ? '<span class="tag on">已启用</span>' : '<span class="tag off">已停用</span>';
    const actions = [
      `<button type="button" class="link" data-language-default="${escapeHtml(item.code)}"${item.isDefault ? ' disabled' : ''}>设为默认</button>`,
      `<button type="button" class="link" data-language-toggle="${escapeHtml(item.code)}">${item.enabled ? '停用' : '启用'}</button>`,
      `<button type="button" class="link" data-language-rename="${escapeHtml(item.code)}">改名</button>`,
      `<button type="button" class="link danger" data-language-delete="${escapeHtml(item.code)}">删除</button>`,
    ];
    return `<tr${item.enabled ? '' : ' class="muted"'}>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${defaultTag}</td>
      <td>${enabledTag}</td>
      <td>${item.filled} 条</td>
      <td class="actions">${actions.join('')}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');
  el('language-empty').classList.toggle('hidden', state.languages.length > 0);
}

// 新建文案的表单按当前登记的语言逐条生成译文输入框，停用的语言照样可以查看与补填
function renderTranslationInputs(values) {
  const box = el('entry-translations');
  const current = values || collectTranslations();
  box.innerHTML = state.languages.map((item) => {
    const value = current[item.code] === undefined ? '' : current[item.code];
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="translation" data-field="translations.${escapeHtml(item.code)}">
      <span>${escapeHtml(item.code)} ${suffix}</span>
      <input class="translation-input" data-code="${escapeHtml(item.code)}" maxlength="200" value="${escapeHtml(value)}">
    </label>`;
  }).join('');
}

function collectTranslations() {
  const result = {};
  document.querySelectorAll('.translation-input').forEach((input) => {
    result[input.dataset.code] = input.value;
  });
  return result;
}

function renderEntries() {
  const head = el('entry-head-row');
  head.innerHTML = ['模块', '文案键']
    .concat(state.languages.map((item) => item.code))
    .concat(['备注', '最近改动人', '更新时间', '操作'])
    .map((text) => `<th>${escapeHtml(text)}</th>`)
    .join('');

  const body = el('entry-body');
  body.innerHTML = state.entries.map((item) => {
    const cells = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) return '<td class="missing">未登记</td>';
      if (!value.trim()) return '<td class="missing">待翻译</td>';
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    });
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
}

function openEntryForm(entry) {
  state.editingId = entry ? entry.id : '';
  el('entry-form-title').textContent = entry ? `编辑文案：${entry.key}` : '新建文案';
  el('entry-module').value = entry ? entry.module : '';
  el('entry-key').value = entry ? entry.key : '';
  el('entry-note').value = entry ? entry.note : '';
  el('entry-translations').innerHTML = '';
  renderTranslationInputs(entry ? entry.translations : {});
  el('entry-form').classList.remove('hidden');
  el('entry-module').focus();
}

function closeEntryForm() {
  state.editingId = '';
  el('entry-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitLanguage(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('language-code').value,
    name: el('language-name').value,
    enabled: el('language-enabled').checked,
    isDefault: el('language-default').checked,
  };
  try {
    await request('/api/languages', { method: 'POST', body: JSON.stringify(payload) });
    el('language-code').value = '';
    el('language-name').value = '';
    el('language-default').checked = false;
    notify('语言已新增', 'ok');
    await loadLanguages();
    await loadEntries();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitEntry(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
  };
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/entries/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文案已保存', 'ok');
    } else {
      await request('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
      notify('文案已新增', 'ok');
    }
    closeEntryForm();
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// ===== 用语清单：规则增删改与执行检查 =====

async function loadRules() {
  const payload = await request('/api/rules');
  state.rules = payload.rules || [];
  renderRules();
}

function ruleTypeTag(type) {
  if (type === 'banned') return '<span class="tag banned">不能出现</span>';
  return '<span class="tag unify">应当统一</span>';
}

function ruleScopeTags(rule) {
  if (rule.scope.all) return '<span class="tag scope all">全部语言</span>';
  if (!rule.scope.languages.length) return '<span class="tag dormant">范围已空（语言被删，规则休眠）</span>';
  return rule.scope.languages.map((code) => `<span class="tag scope">${escapeHtml(code)}</span>`).join('');
}

function renderRules() {
  const body = el('rule-body');
  body.innerHTML = state.rules.map((item) => {
    const suggest = item.replacement
      ? escapeHtml(item.replacement)
      : '<span class="missing">—</span>';
    return `<tr${item.scope.all || item.scope.languages.length ? '' : ' class="muted"'}>
      <td>${ruleTypeTag(item.type)}</td>
      <td class="mono">${escapeHtml(item.phrase)}</td>
      <td class="mono">${suggest}</td>
      <td>${ruleScopeTags(item)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions">
        <button type="button" class="link" data-rule-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-rule-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('rule-empty').classList.toggle('hidden', state.rules.length > 0);
}

// 规则表单与检查条上的语言勾选框按当前登记语言生成，停用语言照样能选
function languageCheckboxes(containerId, selected) {
  const box = el(containerId);
  const chosen = new Set(selected || []);
  box.innerHTML = state.languages.map((item) => {
    const suffix = item.enabled ? '' : ' <span class="tag off">已停用</span>';
    return `<label><input type="checkbox" value="${escapeHtml(item.code)}"${chosen.has(item.code) ? ' checked' : ''}> ${escapeHtml(item.code)}${suffix}</label>`;
  }).join('');
}

function ruleFormMode() {
  const checked = document.querySelector('input[name="rule-scope-mode"]:checked');
  return checked ? checked.value : 'all';
}

function syncRuleScopeUI() {
  const pick = ruleFormMode() === 'pick';
  el('rule-scope-languages').classList.toggle('disabled', !pick);
}

function syncRuleTypeUI() {
  const type = el('rule-type').value;
  if (type === 'banned') {
    el('rule-phrase-label').textContent = '不能出现的词语';
    el('rule-replacement-label').textContent = '修改建议（可选）';
    el('rule-phrase').placeholder = '例如 开小差';
    el('rule-replacement').placeholder = '可留空；填写后检查结果里会给出修改建议';
  } else {
    el('rule-phrase-label').textContent = '现在常见的写法';
    el('rule-replacement-label').textContent = '应当改成的写法';
    el('rule-phrase').placeholder = '例如 帐号';
    el('rule-replacement').placeholder = '例如 账号';
  }
}

function openRuleForm(rule) {
  state.editingRuleId = rule ? rule.id : '';
  el('rule-form-title').textContent = rule ? `编辑用语规则：${rule.phrase}` : '新增用语规则';
  el('rule-type').value = rule ? rule.type : 'unify';
  el('rule-phrase').value = rule ? rule.phrase : '';
  el('rule-replacement').value = rule ? rule.replacement : '';
  el('rule-note').value = rule ? rule.note : '';
  const all = !rule || rule.scope.all;
  el('rule-scope-all').checked = all;
  el('rule-scope-pick').checked = !all;
  languageCheckboxes('rule-scope-languages', rule && !rule.scope.all ? rule.scope.languages : []);
  syncRuleTypeUI();
  syncRuleScopeUI();
  el('rule-form').classList.remove('hidden');
  el('rule-phrase').focus();
}

function closeRuleForm() {
  state.editingRuleId = '';
  el('rule-form').classList.add('hidden');
  clearFieldMarks();
}

function collectRulePayload() {
  const type = el('rule-type').value;
  const all = ruleFormMode() === 'all';
  const languages = Array.from(el('rule-scope-languages').querySelectorAll('input:checked'))
    .map((input) => input.value);
  return {
    type,
    phrase: el('rule-phrase').value,
    replacement: el('rule-replacement').value,
    note: el('rule-note').value,
    scope: all ? { all: true } : { all: false, languages },
  };
}

async function submitRule(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = collectRulePayload();
  const editing = state.editingRuleId;
  try {
    if (editing) {
      await request(`/api/rules/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('用语规则已保存', 'ok');
    } else {
      await request('/api/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify('用语规则已新增', 'ok');
    }
    closeRuleForm();
    await loadRules();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// ===== 执行检查 =====

function checkFormMode() {
  const checked = document.querySelector('input[name="check-scope-mode"]:checked');
  return checked ? checked.value : 'all';
}

function syncCheckScopeUI() {
  const pick = checkFormMode() === 'pick';
  el('check-scope-languages').classList.toggle('disabled', !pick);
}

function collectCheckPayload() {
  const module = el('check-module').value;
  const all = checkFormMode() === 'all';
  const languages = Array.from(el('check-scope-languages').querySelectorAll('input:checked'))
    .map((input) => input.value);
  return {
    module: module || '',
    scope: all ? { all: true } : { all: false, languages },
  };
}

// 把命中位置上的片段在整条译文里高亮出来，其余部分照常转义
function highlightAt(text, index, length, hitClass) {
  const before = escapeHtml(text.slice(0, index));
  const hit = escapeHtml(text.slice(index, index + length));
  const after = escapeHtml(text.slice(index + length));
  return `${before}<mark class="hit ${hitClass}">${hit}</mark>${after}`;
}

function renderCheckResult(result) {
  state.checkResult = result;
  const box = el('check-result');
  box.classList.remove('hidden');
  const { stats, scope, module } = result;
  const scopeText = scope.all ? '全部语言' : `指定的 ${scope.languages.length} 种语言（${scope.languages.join('、')}）`;
  const moduleText = module ? `模块 ${module}` : '全部模块';
  const summary = stats.findings === 0
    ? `已检查${moduleText}、${scopeText}下的 <strong>${stats.translations}</strong> 条译文（${stats.entries} 条文案、${stats.rules} 条生效规则），<span class="ok-num">没有发现命中</span>。`
    : `已检查${moduleText}、${scopeText}下的 <strong>${stats.translations}</strong> 条译文（${stats.entries} 条文案、${stats.rules} 条生效规则），共发现 <span class="bad-num">${stats.findings}</span> 处命中：`;
  el('check-summary').innerHTML = summary;

  const body = el('check-body');
  body.innerHTML = result.findings.map((item, index) => {
    const hitClass = item.ruleType === 'banned' ? 'banned' : 'unify';
    const advice = item.ruleType === 'unify'
      ? `改成「${escapeHtml(item.ruleReplacement)}」`
      : (item.ruleReplacement ? `建议改为「${escapeHtml(item.ruleReplacement)}」` : '请删除或改写这个词语');
    const ruleName = item.ruleType === 'banned'
      ? `不能出现「${escapeHtml(item.rulePhrase)}」`
      : `应当统一「${escapeHtml(item.rulePhrase)} → ${escapeHtml(item.ruleReplacement)}」`;
    return `<tr class="finding-${escapeHtml(item.ruleType)}">
      <td>${index + 1}</td>
      <td>${ruleTypeTag(item.ruleType)}</td>
      <td class="col-key">${escapeHtml(item.key)}</td>
      <td class="mono">${escapeHtml(item.language)}</td>
      <td class="mono">${escapeHtml(item.snippet)}</td>
      <td class="col-translation">${highlightAt(item.translation, item.index, item.snippet.length, hitClass)}</td>
      <td class="rule-ref">${ruleName}<br><span class="mono">${escapeHtml(item.ruleId)}</span></td>
      <td>${advice}</td>
    </tr>`;
  }).join('');
}

async function runCheckFromForm() {
  clearNotice();
  clearFieldMarks();
  const payload = collectCheckPayload();
  try {
    const result = await request('/api/checks', { method: 'POST', body: JSON.stringify(payload) });
    renderCheckResult(result);
    if (result.stats.findings === 0) notify('检查完成，没有发现命中', 'ok');
    else notify(`检查完成，共发现 ${result.stats.findings} 处命中`, 'error');
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const code = node.dataset.languageDefault || node.dataset.languageToggle
    || node.dataset.languageRename || node.dataset.languageDelete;
  if (code) {
    clearNotice();
    try {
      if (node.dataset.languageDefault) {
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
        notify(`${code} 已设为默认语言`, 'ok');
      } else if (node.dataset.languageToggle) {
        const target = state.languages.find((item) => item.code === code);
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !target.enabled }) });
        notify(`${code} 已${target.enabled ? '停用' : '启用'}`, 'ok');
      } else if (node.dataset.languageRename) {
        const target = state.languages.find((item) => item.code === code);
        const next = window.prompt(`把 ${code} 的名称改成`, target ? target.name : '');
        if (next === null) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify(`${code} 的名称已更新`, 'ok');
      } else {
        if (!window.confirm(`确定删除语言 ${code} 吗？`)) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        notify(`${code} 已删除`, 'ok');
      }
      await loadLanguages();
      await loadEntries();
      // 删除语言会把它从规则的生效范围里摘掉，规则表与检查结果需要一并刷新
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.entryEdit) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryEdit);
    if (found) openEntryForm(found);
    return;
  }

  if (node.dataset.entryDelete) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryDelete);
    if (!window.confirm(`确定删除文案 ${found ? found.key : ''} 吗？`)) return;
    try {
      await request(`/api/entries/${encodeURIComponent(node.dataset.entryDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
      notify('文案已删除', 'ok');
      await loadEntries();
      await loadLanguages();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.ruleEdit) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleEdit);
    if (found) openRuleForm(found);
    return;
  }

  if (node.dataset.ruleDelete) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleDelete);
    const label = found ? (found.type === 'banned' ? `禁用词「${found.phrase}」` : `统一规则「${found.phrase} → ${found.replacement}」`) : '';
    if (!window.confirm(`确定删除${label}这条规则吗？`)) return;
    try {
      await request(`/api/rules/${encodeURIComponent(node.dataset.ruleDelete)}`, { method: 'DELETE' });
      if (state.editingRuleId === node.dataset.ruleDelete) closeRuleForm();
      notify('用语规则已删除', 'ok');
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('language-form').addEventListener('submit', submitLanguage);
el('entry-form').addEventListener('submit', submitEntry);
el('entry-new').addEventListener('click', () => {
  clearNotice();
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-module').value = '';
  el('filter-keyword').value = '';
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('entry-refresh').addEventListener('click', () => {
  clearNotice();
  loadLanguages()
    .then(loadEntries)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-module').addEventListener('change', () => {
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 用语规则表单
el('rule-form').addEventListener('submit', submitRule);
el('rule-new').addEventListener('click', () => {
  clearNotice();
  openRuleForm(null);
});
el('rule-cancel').addEventListener('click', closeRuleForm);
el('rule-refresh').addEventListener('click', () => {
  clearNotice();
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-type').addEventListener('change', syncRuleTypeUI);
document.querySelectorAll('input[name="rule-scope-mode"]').forEach((radio) => {
  radio.addEventListener('change', syncRuleScopeUI);
});

// 执行检查
el('check-run').addEventListener('click', runCheckFromForm);
document.querySelectorAll('input[name="check-scope-mode"]').forEach((radio) => {
  radio.addEventListener('change', syncCheckScopeUI);
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列；用语清单随后拉取
restoreOperator();
loadHealth();
loadLanguages()
  .then(loadEntries)
  .then(loadRules)
  .catch((err) => notify(err.message, 'error'));
